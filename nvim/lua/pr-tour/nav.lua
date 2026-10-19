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
    if state.away then
      render.show(state.index)
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

--- The current stop's notes in reading order: by line, and at the same line
--- base before head, so "before" is read ahead of "after".
local function ordered_notes(stop)
  local list = {}
  for i, note in ipairs(stop.notes) do
    if state.wins[note.side] then list[#list + 1] = { note = note, i = i } end
  end
  local side_rank = { base = 1, head = 2 }
  table.sort(list, function(a, b)
    if a.note.line ~= b.note.line then return a.note.line < b.note.line end
    if a.note.side ~= b.note.side then return side_rank[a.note.side] < side_rank[b.note.side] end
    return a.i < b.i
  end)
  return list
end

--- A note-stepping handler: moves to the next or previous note of the current
--- stop, across panes, and echoes it in full with its position ("note 2/3").
local function note_stepper(delta, keys)
  return function()
    if not (state.tour and in_tour_tab()) then return end
    if state.away then render.show(state.index) end
    local notes = ordered_notes(state.tour.stops[state.index])
    local warn = function(msg) vim.api.nvim_echo({ { msg, "WarningMsg" } }, false, {}) end
    if #notes == 0 then return warn("pr-tour: this stop has no notes") end
    local target = state.note_index + delta
    if target > #notes then
      return warn(("pr-tour: last note (%d/%d), %s for the next stop"):format(#notes, #notes, keys.next))
    end
    if target < 1 then
      return warn(("pr-tour: no earlier note, %s for the previous stop"):format(keys.prev))
    end
    state.note_index = target
    local note = notes[target].note
    local win = state.wins[note.side]
    vim.api.nvim_set_current_win(win)
    vim.api.nvim_win_set_cursor(win, { note.line, 0 })
    vim.cmd("normal! zv")
    -- The cursor echo would overwrite the counter on landing; skip it once.
    state.shown_at = win .. ":" .. note.line
    local label, hl = render.note_label(note)
    local msg = ("note %d/%d: %s"):format(target, #notes, label)
    local room = math.max(vim.v.echospace - 1, 10)
    if vim.fn.strdisplaywidth(msg) > room then
      msg = render.fit(msg, room - #(" " .. keys.more)) .. " " .. keys.more
    end
    vim.api.nvim_echo({ { msg, hl } }, false, {})
  end
end

--- The current stop's notes on the cursor line, in full.
local function notes_here()
  local buf = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  return (state.notes[buf] or {})[line] or {}
end

--- The detail float: the cursor line's notes in full, then the stop's `more`.
local function show_more()
  if not (state.tour and in_tour_tab()) then return end
  local stop = state.tour.stops[state.index]
  local lines = {}
  for _, n in ipairs(notes_here()) do lines[#lines + 1] = n.label end
  if stop.more then
    if #lines > 0 then vim.list_extend(lines, { "", "---", "" }) end
    vim.list_extend(lines, vim.split(stop.more, "\n"))
  end
  if #lines == 0 then
    vim.api.nvim_echo({ { "pr-tour: no note on this line and no detail for this stop" } }, false, {})
    return
  end
  local _, win = vim.lsp.util.open_floating_preview(lines, "markdown", {
    border = "rounded",
    max_width = 80,
    wrap = true,
    focus_id = "pr-tour-more",
  })
  vim.w[win]["pr-tour-more"] = true
end

local echoed = false -- whether the last cursor echo showed a note

--- Echo the cursor line's notes in full when any of them is trimmed on screen.
--- Returns the full text, or nil when there is nothing trimmed here.
function M.echo_note()
  if not (state.tour and in_tour_tab()) then return nil end
  local here, trimmed = notes_here(), false
  for _, n in ipairs(here) do trimmed = trimmed or n.trimmed end
  if not trimmed then
    if echoed then vim.api.nvim_echo({ { "" } }, false, {}) end
    echoed = false
    return nil
  end
  local parts = {}
  for _, n in ipairs(here) do parts[#parts + 1] = n.label end
  local text = table.concat(parts, "   ")
  vim.api.nvim_echo({ { render.fit(text, math.max(vim.v.echospace - 1, 10)), here[1].hl } }, false, {})
  echoed = true
  return text
end

--- The reviewer's global normal-mode mapping for `lhs`, or false. Not maparg:
--- it returns the current buffer's local mapping when there is one, and the
--- global mapping would then be overwritten and never restored.
local function global_map(lhs)
  local want = vim.keycode(lhs)
  for _, m in ipairs(vim.api.nvim_get_keymap("n")) do
    if vim.keycode(m.lhs) == want then return m end
  end
  return false
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
  local last_line = nil
  vim.api.nvim_create_autocmd("CursorMoved", {
    group = augroup,
    callback = function()
      local key = vim.api.nvim_get_current_win() .. ":" .. vim.api.nvim_win_get_cursor(0)[1]
      if key == last_line then return end
      last_line = key
      -- Landing on a stop keeps its title in the echo area once; the note shows on any later visit or via gL.
      local landing = key == state.shown_at
      state.shown_at = nil
      if not landing then M.echo_note() end
    end,
  })
  local maps = {
    { keys.next, stepper(1, keys.next), "pr-tour: next stop" },
    { keys.prev, stepper(-1, keys.prev), "pr-tour: previous stop" },
    { keys.more, show_more, "pr-tour: stop detail" },
    { keys.next_note, note_stepper(1, keys), "pr-tour: next note" },
    { keys.prev_note, note_stepper(-1, keys), "pr-tour: previous note" },
  }
  for _, m in ipairs(maps) do
    saved_maps[m[1]] = global_map(m[1])
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
--- file, else open it alone. The current stop is unchanged, but the reviewer is
--- marked away from it: the next ]s or [s re-shows that stop instead of stepping.
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
  state.away = true
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
  vim.cmd("normal! zvzz")
  return { ok = true, side = side, file = args.file, line = line }
end

return M
