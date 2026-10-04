-- Optional hall geometry for the seat map. Seats stay one row per label (the engine never reads
-- this). The layout only tells the UI where the walking space goes:
--   {"aisles_after": [4, 12], "row_gaps_after": ["E"]}
--   aisles_after    a vertical aisle after these seat numbers (counted within a row)
--   row_gaps_after  a cross-aisle after these row labels
-- NULL (shows created by scripts with arbitrary labels): the UI derives a plain grid from the
-- labels instead.
alter table shows
  add column layout jsonb check (layout is null or jsonb_typeof(layout) = 'object');
