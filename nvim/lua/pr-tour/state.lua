-- The single source of truth for the loaded tour. clear() resets it.
local M = {}

function M.reset()
  M.tour = nil -- validated tour (see tour.validate)
  M.index = 0 -- current stop, 1-based
  M.tab = nil -- tour tabpage handle
  M.wins = {} -- side ("base"/"head") -> window showing it in the current layout
  M.decorated = {} -- buffer -> true for buffers holding pr-tour extmarks
  M.real_roots = {} -- side -> realpath of that worktree
  M.away = false -- true after a jump moved the reviewer off the current stop
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
