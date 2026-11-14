namespace Vroom.Core.Storage;

public sealed partial class CatalogDatabase
{
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS films(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, added TEXT NOT NULL, selected_part_id TEXT, revision INTEGER NOT NULL DEFAULT 1);
        CREATE INDEX IF NOT EXISTS ix_films_library_added ON films(library_id,added);
        CREATE TABLE IF NOT EXISTS media_files(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id), path TEXT NOT NULL, path_key TEXT NOT NULL, filesystem_identity TEXT, payload TEXT NOT NULL, UNIQUE(library_id,path_key));
        CREATE INDEX IF NOT EXISTS ix_media_files_identity ON media_files(library_id,filesystem_identity);
        CREATE TABLE IF NOT EXISTS media_versions(id TEXT PRIMARY KEY, film_id TEXT NOT NULL REFERENCES films(id) ON DELETE CASCADE, name TEXT NOT NULL, ordinal INTEGER NOT NULL, UNIQUE(film_id,ordinal));
        CREATE TABLE IF NOT EXISTS media_parts(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES media_versions(id) ON DELETE CASCADE, file_id TEXT NOT NULL REFERENCES media_files(id), ordinal INTEGER NOT NULL, position REAL NOT NULL DEFAULT 0, UNIQUE(version_id,ordinal), UNIQUE(version_id,file_id));
        CREATE TABLE IF NOT EXISTS resource_sets(id TEXT PRIMARY KEY, film_id TEXT NOT NULL REFERENCES films(id) ON DELETE CASCADE, version_id TEXT REFERENCES media_versions(id), part_id TEXT REFERENCES media_parts(id), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resource_members(set_id TEXT NOT NULL REFERENCES resource_sets(id) ON DELETE CASCADE,file_id TEXT NOT NULL REFERENCES media_files(id),ordinal INTEGER NOT NULL,PRIMARY KEY(set_id,file_id),UNIQUE(set_id,ordinal));
        CREATE TABLE IF NOT EXISTS media_scope_projection(subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,part_id TEXT NOT NULL,PRIMARY KEY(subject_id,scope_id));
        CREATE VIEW IF NOT EXISTS media_file_projection AS SELECT m.id,m.library_id,m.path,m.path_key,m.filesystem_identity,
          json_patch(m.payload,json_object('id',m.id,'libraryId',m.library_id,'path',m.path,'fileSystemIdentity',m.filesystem_identity)) AS payload FROM media_files m;
        CREATE VIEW IF NOT EXISTS film_projection AS
          SELECT f.id,f.library_id,f.added,m.path,m.path_key,
            json_patch(COALESCE(m.payload,'{}'),json_object('id',f.id,'libraryId',f.library_id,'added',f.added,
            'path',COALESCE(m.path,''),'fileId',m.id,'versionId',v.id,'partId',p.id,'position',COALESCE(p.position,0),'structureRevision',f.revision)) AS payload
          FROM films f LEFT JOIN media_parts p ON p.id=f.selected_part_id
          LEFT JOIN media_versions v ON v.id=p.version_id AND v.film_id=f.id LEFT JOIN media_files m ON m.id=p.file_id;
        CREATE VIEW IF NOT EXISTS media_part_projection AS
          SELECT f.id,f.library_id,f.added,p.id AS part_id,m.path,m.path_key,
            json_patch(m.payload,json_object('id',f.id,'libraryId',f.library_id,'added',f.added,
            'path',m.path,'fileId',m.id,'versionId',v.id,'partId',p.id,'position',p.position,'structureRevision',f.revision)) AS payload
          FROM films f JOIN media_versions v ON v.film_id=f.id JOIN media_parts p ON p.version_id=v.id JOIN media_files m ON m.id=p.file_id;
        CREATE TABLE IF NOT EXISTS media_work(film_id TEXT NOT NULL REFERENCES films(id) ON DELETE CASCADE, part_id TEXT NOT NULL, kind TEXT NOT NULL, library_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated TEXT NOT NULL, PRIMARY KEY(film_id,part_id,kind));
        CREATE INDEX IF NOT EXISTS ix_media_work_library ON media_work(library_id,state);
        CREATE TABLE IF NOT EXISTS playback_state(film_id TEXT PRIMARY KEY REFERENCES films(id) ON DELETE CASCADE, last_played TEXT NOT NULL, resume INTEGER NOT NULL DEFAULT 0, completed_count INTEGER NOT NULL DEFAULT 0, last_completed TEXT);
        CREATE INDEX IF NOT EXISTS ix_playback_state_played ON playback_state(last_played);
        CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS background_jobs(id TEXT PRIMARY KEY, state INTEGER NOT NULL, kind TEXT NOT NULL, updated TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_background_jobs_state ON background_jobs(state,updated);
        CREATE TABLE IF NOT EXISTS job_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES background_jobs(id), time TEXT NOT NULL, state INTEGER NOT NULL, detail TEXT NOT NULL);
        PRAGMA user_version=4;
        """;

    // Annotation, configuration, event and source tables. All catalog tables are created here, in one
    // place and one transaction, so every service can rely on them regardless of start-up order.
    private const string TagSchema = """
        CREATE TABLE IF NOT EXISTS tag_terms_stamp(id INTEGER PRIMARY KEY CHECK(id=1),stamp TEXT NOT NULL);
        INSERT OR IGNORE INTO tag_terms_stamp VALUES(1,'initial');
        CREATE TABLE IF NOT EXISTS tag_scope_index(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,kind TEXT NOT NULL,start_us INTEGER NOT NULL,end_us INTEGER NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id));
        CREATE TABLE IF NOT EXISTS tag_raw_references(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,tag_key TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id,tag_key,target_id));
        CREATE INDEX IF NOT EXISTS ix_tag_raw_target ON tag_raw_references(target_id,subject_kind,subject_id);
        CREATE TABLE IF NOT EXISTS tag_terms(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_term_history(id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS tag_term_catalog(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_reference_edges(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,tag_key TEXT NOT NULL,target_id TEXT NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id,tag_key,target_id));
        CREATE INDEX IF NOT EXISTS ix_tag_reference_target ON tag_reference_edges(target_id,subject_kind,tag_key);
        CREATE TABLE IF NOT EXISTS tag_state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, system_hash TEXT NOT NULL, package TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_objects(kind TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,key));
        CREATE TABLE IF NOT EXISTS tag_generations(generation INTEGER PRIMARY KEY,package TEXT NOT NULL,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_heads(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,tag_key TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id,tag_key));
        CREATE INDEX IF NOT EXISTS ix_tag_heads_field ON tag_heads(tag_key,subject_kind,subject_id);
        CREATE TABLE IF NOT EXISTS tag_history(id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS tag_effective(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,tag_key TEXT NOT NULL,value_json TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id,tag_key));
        CREATE INDEX IF NOT EXISTS ix_tag_effective_lookup ON tag_effective(tag_key,scope_id,subject_id);
        CREATE TABLE IF NOT EXISTS tag_issues(subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,scope_id TEXT NOT NULL,tag_key TEXT NOT NULL,code TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(subject_kind,subject_id,scope_id,tag_key));
        CREATE TABLE IF NOT EXISTS tag_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS tag_rule_runs(event_id TEXT NOT NULL,rule_key TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(event_id,rule_key));
        CREATE TABLE IF NOT EXISTS tag_candidates(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,tag_key TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
        CREATE INDEX IF NOT EXISTS ix_tag_candidates_state_key ON tag_candidates(state,tag_key);
        CREATE TABLE IF NOT EXISTS tag_previews(id TEXT PRIMARY KEY,kind TEXT NOT NULL,generation INTEGER NOT NULL,payload TEXT NOT NULL,result TEXT,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_bulk_items(preview_id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(preview_id,ordinal));
        CREATE TABLE IF NOT EXISTS tag_idempotency(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_import_archives(hash TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_source_observations(id TEXT PRIMARY KEY,subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,tag_key TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tag_entity_identities(namespace TEXT NOT NULL,external_id TEXT NOT NULL,term_id TEXT NOT NULL,PRIMARY KEY(namespace,external_id));
        CREATE TABLE IF NOT EXISTS tag_subscriptions(source_id TEXT NOT NULL,subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,configuration TEXT NOT NULL,next_run TEXT NOT NULL,job_id TEXT,PRIMARY KEY(source_id,subject_kind,subject_id));
        CREATE TABLE IF NOT EXISTS tag_source_cache(key TEXT PRIMARY KEY,payload TEXT NOT NULL,expires TEXT NOT NULL);
        """;
}
