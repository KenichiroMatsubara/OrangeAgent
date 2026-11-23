-- A Run records how long it held its browser: the milliseconds from
-- acquiring a Browser Run session to closing it, which is the time Browser
-- Run bills. A Run that never started a browser held it for none.
--
-- The column is added NOT NULL with a default of 0, which its check accepts,
-- so every Run written before this reads 0 and no row can fail it. Nothing
-- earlier wrote it.
ALTER TABLE `runs` ADD COLUMN `browser_ms` integer DEFAULT 0 NOT NULL CHECK (`browser_ms` >= 0);
