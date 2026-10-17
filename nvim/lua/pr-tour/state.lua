-- The single source of truth for the loaded tour. reset() clears it.
local M = {}

function M.reset()
  M.tour = nil -- validated tour (see tour.validate)
  M.index = 0 -- current stop, 1-based
  M.tab = nil -- tour tabpage handle
  M.wins = {} -- side ("base"/"head") -> window showing it in the current layout
  M.decorated = {} -- buffer -> true for buffers holding pr-tour extmarks
  M.notes = {} -- buffer -> line -> { {label, hl, trimmed} } for the current stop's notes
  M.real_roots = {} -- side -> realpath of that worktree
  M.shown_at = nil -- "win:line" where the last show() put the cursor
  M.away = false -- true after a jump moved the reviewer off the current stop
  M.note_index = 0 -- the current stop's note ]n / [n last moved to (0 = none yet)
  M.last_visual = nil -- { buf, time } when visual mode was last left
end

--- Which worktree a path belongs to, and its path relative to that root.
--- Base is checked first in case one worktree is nested inside the other.
function M.side_of(path)
  if not path or path == "" then return nil end
  local real = vim.uv.fs_realpath(path)
  if not real then return nil end
  for _, side in ipairs({ "base", "head" }) do
    local root = M.real_roots[side]
    if root and (real == root or vim.startswith(real, root .. "/")) then
      return side, real:sub(#root + 2)
    end
  end
  return nil
end

M.reset()
return M
