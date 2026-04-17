-- Drop the inert effective_mode column from family_profile_rollups.
--
-- Pass 1 stopped writing meaningful values into this column (publisher now
-- writes NULL) and removed the corresponding reader in api/web. With no
-- consumers, the column is now removed from the control schema.

ALTER TABLE family_profile_rollups DROP COLUMN effective_mode;
