use super::*;
use uuid::Uuid;

/// The test database is left unmigrated so `public` holds only these relations.
#[sqlx::test(migrations = false)]
async fn partition_storage_includes_descendants_indexes_and_keeps_blobs_separate(
    pool: sqlx::PgPool,
) -> Result<()> {
    sqlx::raw_sql(r"
        CREATE TABLE storage_frames (day INT, id INT, payload TEXT) PARTITION BY RANGE(day);
        CREATE TABLE storage_frames_old PARTITION OF storage_frames FOR VALUES FROM(0) TO(10);
        CREATE TABLE storage_frames_recent PARTITION OF storage_frames FOR VALUES FROM(10) TO(20) PARTITION BY RANGE(id);
        CREATE TABLE storage_frames_recent_a PARTITION OF storage_frames_recent FOR VALUES FROM(0) TO(10000);
        CREATE TABLE storage_frames_recent_default PARTITION OF storage_frames_recent DEFAULT;
        CREATE INDEX ON storage_frames(day,id);
        INSERT INTO storage_frames SELECT 1,n,md5(n::TEXT) FROM generate_series(1,4000) n;
        INSERT INTO storage_frames SELECT 11,n,md5(n::TEXT) FROM generate_series(1,4000) n;
        INSERT INTO storage_frames VALUES(11,10001,'default child');
        CREATE TABLE storage_ordinary(id INT,payload TEXT);
        CREATE INDEX ON storage_ordinary(id);
        INSERT INTO storage_ordinary SELECT n,md5(n::TEXT) FROM generate_series(1,1000) n;
    ").execute(&pool).await?;
    let schema = "public";
    let tables = query_relation_storage(&pool, schema).await?;
    assert_eq!(tables.len(), 2); // only logical roots, no partition rows
    let actual = tables
        .iter()
        .find(|t| t.name == "storage_frames")
        .unwrap()
        .bytes;
    let parent: i64 = sqlx::query_scalar("SELECT pg_total_relation_size('storage_frames')")
        .fetch_one(&pool)
        .await?;
    assert_eq!(
        parent, 0,
        "partitioned parent does not account for its children"
    );
    let expected: i64 = sqlx::query_scalar(
        r"SELECT pg_total_relation_size('storage_frames_old')
        +pg_total_relation_size('storage_frames_recent_a')
        +pg_total_relation_size('storage_frames_recent_default')",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(actual, expected);
    assert!(actual > 0);
    let ordinary: i64 = sqlx::query_scalar("SELECT pg_total_relation_size('storage_ordinary')")
        .fetch_one(&pool)
        .await?;
    assert_eq!(
        tables
            .iter()
            .find(|t| t.name == "storage_ordinary")
            .unwrap()
            .bytes,
        ordinary
    );
    let root = std::env::temp_dir().join(format!("vantyr-accounting-{}", Uuid::new_v4()));
    let day = root.join(Uuid::new_v4().to_string()).join("20260101");
    std::fs::create_dir_all(day.join("thumbs"))?;
    std::fs::write(day.join("retained.jpg"), vec![0; 12345])?;
    std::fs::write(day.join("orphan.jpg"), vec![0; 4567])?;
    std::fs::write(day.join("thumbs/cache.jpg"), vec![0; 2345])?;
    assert_eq!(std::fs::metadata(day.join("retained.jpg"))?.len(), 12345);
    let after = query_relation_storage(&pool, schema).await?;
    assert_eq!(
        tables, after,
        "filesystem JPEG/orphan/cache bytes are outside DB accounting"
    );
    let report = storage_report(actual + ordinary + 8192, tables)?;
    assert_eq!(report.public_tables_bytes, actual + ordinary);
    assert_eq!(report.other_bytes, 8192);
    sqlx::raw_sql("DROP TABLE storage_frames_old")
        .execute(&pool)
        .await?;
    let after = query_relation_storage(&pool, schema).await?;
    assert!(
        after
            .iter()
            .find(|t| t.name == "storage_frames")
            .unwrap()
            .bytes
            < actual
    );
    assert!(
        day.join("retained.jpg").exists(),
        "DB partition deletion does not itself delete a JPEG"
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn storage_report_rejects_invalid_counts_and_saturates_concurrent_estimates() {
    let table = |bytes| TableStorage {
        name: "t".into(),
        bytes,
    };
    assert!(storage_report(1, vec![table(-1)]).is_err());
    assert!(storage_report(i64::MAX, vec![table(i64::MAX), table(1)]).is_err());
    assert_eq!(storage_report(1, vec![table(8192)]).unwrap().other_bytes, 0);
}

#[sqlx::test(migrations = false)]
async fn ordinary_multiple_inheritance_is_counted_once_as_separate_relations(
    pool: sqlx::PgPool,
) -> Result<()> {
    sqlx::raw_sql(
        r"
        CREATE TABLE inheritance_left(id INT);
        CREATE TABLE inheritance_right(id INT);
        CREATE TABLE inheritance_child(payload TEXT) INHERITS(inheritance_left,inheritance_right);
        CREATE INDEX ON inheritance_child(id);
        INSERT INTO inheritance_left VALUES(1);
        INSERT INTO inheritance_right VALUES(2);
        INSERT INTO inheritance_child SELECT n,md5(n::TEXT) FROM generate_series(1,1000) n;
    ",
    )
    .execute(&pool)
    .await?;
    let schema = "public";
    let tables = query_relation_storage(&pool, schema).await?;
    assert_eq!(tables.len(), 3);
    for table in &tables {
        let name = table.name.as_str();
        let expected:i64=sqlx::query_scalar("SELECT pg_total_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2")
            .bind(schema).bind(name).fetch_one(&pool).await?;
        assert_eq!(table.bytes, expected);
    }
    let expected:i64=sqlx::query_scalar("SELECT pg_total_relation_size('inheritance_left')+pg_total_relation_size('inheritance_right')+pg_total_relation_size('inheritance_child')")
        .fetch_one(&pool).await?;
    let report = storage_report(expected, tables)?;
    assert_eq!(report.public_tables_bytes, expected);
    assert_eq!(report.other_bytes, 0);
    Ok(())
}
