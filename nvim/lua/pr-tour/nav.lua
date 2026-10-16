-- Reviewer-side controls for a loaded tour: stop keymaps, the detail float,
-- visual-selection tracking, and the where/jump queries the CLI makes.
local state = require("pr-tour.state")
local render = require("pr-tour.render")
local tour = require("pr-tour.tour")

local M = {}
local augroup = nil
local saved_maps = {} -- lhs -> the global mapping that existed before the tour, or false

local function in_tour_tab()
  return state.tab ~= nil
    and vim.api.nvim_tabpage_is_valid(state.tab)
    and vim.api.nvim_get_current_tabpage() == state.tab
end

--- A stop-stepping handler. Outside the tour tab the key keeps its built-in
--- meaning (]s / [s are spell navigation). Global rather than buffer-local so
--- files opened via gd inside the tour tab get the keys too.
local function stepper(delta, lhs)
  return function()
    if not (state.tour and in_tour_tab()) then
      pcall(vim.cmd.normal, { args = { vim.v.count1 .. vim.keycode(lhs) }, bang = true })
      return
    end
    local target = math.max(1, math.min(#state.tour.stops, state.index + delta))
    if target == state.index then
      vim.api.nvim_echo({ { delta > 0 and "pr-tour: last stop" or "pr-tour: first stop", "WarningMsg" } }, false, {})
      return
    end
    render.show(target)
  end
end

local function show_more()
  if not (state.tour and in_tour_tab()) then return end
  local stop = state.tour.stops[state.index]
  if not stop.more then
    vim.api.nvim_echo({ { "pr-tour: no detail for this stop" } }, false, {})
    return
  end
  vim.lsp.util.open_floating_preview(vim.split(stop.more, "\n"), "markdown", {
    border = "rounded",
    max_width = 80,
    focus_id = "pr-tour-more",
  })
end

--- Install keymaps and selection tracking for a newly loaded tour.
function M.attach(keys)
  M.detach()
  augroup = vim.api.nvim_create_augroup("pr-tour-nav", { clear = true })
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = augroup,
    pattern = "[vV\22]*:[^vV\22]*",
    callback = function()
      state.last_visual = { buf = vim.api.nvim_get_current_buf(), time = os.time() }
    end,
  })
  local maps = {
    { keys.next, stepper(1, keys.next), "pr-tour: next stop" },
    { keys.prev, stepper(-1, keys.prev), "pr-tour: previous stop" },
    { keys.more, show_more, "pr-tour: stop detail" },
  }
  for _, m in ipairs(maps) do
    local existing = vim.fn.maparg(m[1], "n", false, true)
    saved_maps[m[1]] = (existing.lhs ~= nil and existing.buffer == 0) and existing or false
    vim.keymap.set("n", m[1], m[2], { desc = m[3] })
  end
end

--- Remove the tour's keymaps (restoring the reviewer's own) and autocmds.
function M.detach()
  if augroup then
    pcall(vim.api.nvim_del_augroup_by_id, augroup)
    augroup = nil
  end
  for lhs, saved in pairs(saved_maps) do
    pcall(vim.keymap.del, "n", lhs)
    if saved then vim.fn.mapset("n", false, saved) end
  end
  saved_maps = {}
end

--- The live visual selection if Neovim is still in visual mode (switching
--- terminal panes does not leave it), else the last one, with its age.
--- Linewise: charwise selections report whole lines.
local function selection()
  local buf, s, e, age
  if vim.api.nvim_get_mode().mode:match("^[vV\22]") then
    buf = vim.api.nvim_get_current_buf()
    s, e, age = vim.fn.getpos("v")[2], vim.fn.getpos(".")[2], 0
  elseif state.last_visual and vim.api.nvim_buf_is_valid(state.last_visual.buf) then
    buf = state.last_visual.buf
    s = vim.api.nvim_buf_get_mark(buf, "<")[1]
    e = vim.api.nvim_buf_get_mark(buf, ">")[1]
    age = os.time() - state.last_visual.time
  else
    return vim.NIL
  end
  if s == 0 or e == 0 then return vim.NIL end
  if s > e then s, e = e, s end
  local name = vim.api.nvim_buf_get_name(buf)
  local side, rel = state.side_of(name)
  return {
    file = rel or name,
    side = side or vim.NIL,
    startLine = s,
    endLine = e,
    text = table.concat(vim.api.nvim_buf_get_lines(buf, s - 1, e, false), "\n"),
    ageSeconds = age,
  }
end

function M.where()
  if not state.tour then return { ok = false, error = "no tour loaded" } end
  local name = vim.api.nvim_buf_get_name(0)
  local side, rel = state.side_of(name)
  return {
    ok = true,
    inTourTab = in_tour_tab(),
    stop = state.index,
    stops = #state.tour.stops,
    title = state.tour.stops[state.index].title,
    side = side or vim.NIL,
    file = rel or name,
    line = vim.api.nvim_win_get_cursor(0)[1],
    selection = selection(),
  }
end

--- Point the reviewer at a location: reuse a tour window already showing the
--- file, else open it alone. The current stop is unchanged; ]s returns to it.
function M.jump(args)
  if not state.tour then return { ok = false, error = "no tour loaded" } end
  local side = args.before and "base" or "head"
  local path = vim.fs.normalize(state.tour.roots[side] .. "/" .. tostring(args.file))
  local n = tour.file_lines(path)
  if not n then return { ok = false, error = side .. " file not found: " .. path } end
  local line = tonumber(args.line)
  if not line or line < 1 or line > n then
    return { ok = false, error = ("line %s is outside the %s file (%d lines)"):format(tostring(args.line), side, n) }
  end
  render.ensure_tab()
  local target
  for _, win in pairs(state.wins) do
    if vim.api.nvim_win_is_valid(win) and vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) == path then
      target = win
    end
  end
  if not target then target = render.show_single(path, side) end
  vim.api.nvim_set_current_win(target)
  local count = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(target))
  vim.api.nvim_win_set_cursor(target, { math.min(line, count), 0 })
  vim.cmd("normal! zz")
  return { ok = true, side = side, file = args.file, line = line }
end

return M
