CREATE TABLE IF NOT EXISTS publication_journal (
    job_id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
);
