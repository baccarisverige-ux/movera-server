-- movera-server migration 0015: the Stockholm county zone reaches Nynäshamn and the southern archipelago.
-- 0014 drew Z001's south edge at 58.95; Nynäshamn (58.90) and Landsort (58.74) are in the county too.
UPDATE zones SET south = 58.70 WHERE zone_id = 'Z001';
