-- Draws one tour stop: the tour tab, its windows (diff split or single pane),
-- the focus range, and pinned notes. Also keeps base-worktree buffers read-only.
local state = require("pr-tour.state")

local M = {}
M.ns = vim.api.nvim_create_namespace("pr-tour")
local augroup = nil

--- Make a base-worktree buffer read-only so old code can't be edited by accident.
function M.lock_if_base(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  if state.side_of(vim.api.nvim_buf_get_name(buf)) == "base" then
    vim.bo[buf].modifiable = false
    vim.bo[buf].readonly = true
  end
end

--- Begin a tour: lock base buffers as they open, including ones reached via gd.
function M.start()
  augroup = vim.api.nvim_create_augroup("pr-tour-render", { clear = true })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufWinEnter" }, {
    group = augroup,
    callback = function(ev) M.lock_if_base(ev.buf) end,
  })
end

--- End a tour's rendering: remove every pin and the lock autocmd.
function M.stop()
  M.clear_marks()
  if augroup then
    pcall(vim.api.nvim_del_augroup_by_id, augroup)
    augroup = nil
  end
end

function M.clear_marks()
  for buf in pairs(state.decorated) do
    if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_buf_clear_namespace(buf, M.ns, 0, -1) end
  end
  state.decorated = {}
end

--- Switch to the tour tab, creating it when missing.
function M.ensure_tab()
  if state.tab and vim.api.nvim_tabpage_is_valid(state.tab) then
    vim.api.nvim_set_current_tabpage(state.tab)
    return
  end
  vim.cmd("tabnew")
  state.tab = vim.api.nvim_get_current_tabpage()
  state.wins = {}
end

--- Show `path` in `win`. An already-loaded buffer is never reloaded (plain bufload skips SwapExists, so an unloaded one is read with :edit), so the
--- reviewer's unsaved changes survive.
local function open_in(win, path)
  local buf = vim.fn.bufadd(path)
  local swap_group = vim.api.nvim_create_augroup("pr-tour-swap", { clear = true })
  vim.api.nvim_create_autocmd("SwapExists", {
    group = swap_group,
    callback = function() vim.v.swapchoice = "o" end,
  })
  local ok, err = true, nil
  if not vim.api.nvim_buf_is_loaded(buf) then
    ok, err = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("silent edit") end)
  end
  pcall(vim.api.nvim_del_augroup_by_id, swap_group)
  if not ok then error(err, 0) end
  vim.bo[buf].buflisted = true
  vim.api.nvim_win_set_buf(win, buf)
  if vim.bo[buf].filetype == "" then
    vim.api.nvim_buf_call(buf, function() vim.cmd("filetype detect") end)
  end
  M.lock_if_base(buf)
  return buf
end

--- True when the tour tab shows exactly this stop's files and nothing else.
local function layout_intact(stop)
  if not (state.tab and vim.api.nvim_tabpage_is_valid(state.tab)) then return false end
  local expected = 0
  for side, path in pairs(stop.paths) do
    local win = state.wins[side]
    if not (win and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_tabpage(win) == state.tab) then
      return false
    end
    if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) ~= path then return false end
    expected = expected + 1
  end
  local visible = 0
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(state.tab)) do
    if vim.api.nvim_win_get_config(w).relative == "" then visible = visible + 1 end
  end
  return visible == expected
end

-- `only` relies on 'hidden' (Neovim's default) to keep modified buffers alive.
local function reset_windows()
  vim.cmd("diffoff!")
  vim.cmd("silent! only")
  return vim.api.nvim_get_current_win()
end

local function build_layout(stop)
  local first = reset_windows()
  if stop.view == "split" then
    open_in(first, stop.paths.base)
    vim.cmd("rightbelow vsplit")
    local second = vim.api.nvim_get_current_win()
    open_in(second, stop.paths.head)
    state.wins = { base = first, head = second }
    for _, w in ipairs({ first, second }) do
      vim.api.nvim_win_call(w, function() vim.cmd("diffthis") end)
    end
  else
    open_in(first, stop.paths[stop.focus])
    state.wins = { [stop.focus] = first }
  end
end

--- Open one file full-width in the tour tab (used by jump). Returns its window.
function M.show_single(path, side)
  M.ensure_tab()
  local win = reset_windows()
  open_in(win, path)
  state.wins = { [side] = win }
  return win
end

local function wrap(text, width)
  local out, cur = {}, ""
  for word in text:gmatch("%S+") do
    if cur == "" then
      cur = word
    elseif vim.fn.strdisplaywidth(cur .. " " .. word) <= width then
      cur = cur .. " " .. word
    else
      out[#out + 1] = cur
      cur = word
    end
  end
  if cur ~= "" then out[#out + 1] = cur end
  return out
end

local function note_label(note)
  if note.kind == "finding" then
    return ("◆ [%s] %s"):format(note.severity, note.text), "PrTourFinding"
  end
  return "◀ " .. note.text, "PrTourNote"
end

--- Pin a note at end of line, or on wrapped virtual lines below when it is wider
--- than the space left in the window.
local function place_note(buf, win, note)
  local label, hl = note_label(note)
  local row = note.line - 1
  local info = vim.fn.getwininfo(win)[1]
  local text_width = info.width - info.textoff
  local line_text = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
  local room = text_width - vim.fn.strdisplaywidth(line_text) - 2
  local opts = {}
  if vim.fn.strdisplaywidth(label) <= room then
    opts.virt_text = { { label, hl } }
    opts.virt_text_pos = "eol"
  else
    opts.virt_lines = {}
    for _, l in ipairs(wrap(label, math.max(text_width - 4, 20))) do
      opts.virt_lines[#opts.virt_lines + 1] = { { "    " .. l, hl } }
    end
  end
  if note.kind == "finding" then
    opts.sign_text = "◆"
    opts.sign_hl_group = "PrTourFinding"
  end
  vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, opts)
end

--- Open any closed fold holding `row` in `win`. Diff mode folds unchanged
--- regions away from hunks, and setting the cursor does not open them.
local function reveal(win, row)
  local count = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  row = math.max(1, math.min(row, count))
  vim.api.nvim_win_call(win, function()
    if vim.fn.foldclosed(row) ~= -1 then vim.cmd(row .. "foldopen!") end
  end)
end

--- Render stop `index` of the loaded tour and put the cursor on its focus line.
function M.show(index)
  local stop = state.tour.stops[index]
  state.index = index
  state.away = false
  M.ensure_tab()
  if not layout_intact(stop) then build_layout(stop) end
  M.clear_marks()
  for side, win in pairs(state.wins) do
    local buf = vim.api.nvim_win_get_buf(win)
    state.decorated[buf] = true
    if side == stop.focus then
      for row = stop.line - 1, stop.endLine - 1 do
        vim.api.nvim_buf_set_extmark(buf, M.ns, row, 0, { line_hl_group = "PrTourFocus" })
      end
    end
    reveal(win, stop.line)
    for _, note in ipairs(stop.notes) do
      if note.side == side then
        place_note(buf, win, note)
        reveal(win, note.line)
      end
    end
  end
  local win = state.wins[stop.focus]
  vim.api.nvim_set_current_win(win)
  vim.api.nvim_win_set_cursor(win, { stop.line, 0 })
  vim.cmd("normal! zvzz")
  -- Truncated to the echo area: an overlong message raises a hit-enter prompt,
  -- which would block every later RPC call from the CLI.
  local msg = ("pr-tour %d/%d: %s"):format(index, #state.tour.stops, stop.title)
  vim.api.nvim_echo({ { msg:sub(1, math.max(vim.v.echospace - 1, 10)) } }, false, {})
end

return M
