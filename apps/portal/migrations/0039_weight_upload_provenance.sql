-- NULL leaves legacy provenance unknown; [] means every used weight was proven committed.
ALTER TABLE local_reports ADD COLUMN weights_uploaded_json TEXT;
