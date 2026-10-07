use super::*;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL/filesystem fixtures only"]
async fn partition_storage_includes_descendants_indexes_and_keeps_blobs_separate() -> Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("TEST_DATABASE_URL")?)
        .await?;
    sqlx::raw_sql(r"
        CREATE TEMP TABLE storage_frames (day INT, id INT, payload TEXT) PARTITION BY RANGE(day);
        CREATE TEMP TABLE storage_frames_old PARTITION OF storage_frames FOR VALUES FROM(0) TO(10);
        CREATE TEMP TABLE storage_frames_recent PARTITION OF storage_frames FOR VALUES FROM(10) TO(20) PARTITION BY RANGE(id);
        CREATE TEMP TABLE storage_frames_recent_a PARTITION OF storage_frames_recent FOR VALUES FROM(0) TO(10000);
        CREATE TEMP TABLE storage_frames_recent_default PARTITION OF storage_frames_recent DEFAULT;
        CREATE INDEX ON storage_frames(day,id);
        INSERT INTO storage_frames SELECT 1,n,md5(n::TEXT) FROM generate_series(1,4000) n;
        INSERT INTO storage_frames SELECT 11,n,md5(n::TEXT) FROM generate_series(1,4000) n;
        INSERT INTO storage_frames VALUES(11,10001,'default child');
        CREATE TEMP TABLE storage_ordinary(id INT,payload TEXT);
        CREATE INDEX ON storage_ordinary(id);
        INSERT INTO storage_ordinary SELECT n,md5(n::TEXT) FROM generate_series(1,1000) n;
    ").execute(&pool).await?;
    let schema: String =
        sqlx::query_scalar("SELECT nspname::text FROM pg_namespace WHERE oid=pg_my_temp_schema()")
            .fetch_one(&pool)
            .await?;
    let tables = query_relation_storage(&pool, &schema).await?;
    assert_eq!(tables.len(), 2); // only logical roots, no partition rows
    let actual = tables
        .iter()
        .find(|t| t["name"] == "storage_frames")
        .unwrap()["bytes"]
        .as_i64()
        .unwrap();
    let parent: i64 = sqlx::query_scalar("SELECT pg_total_relation_size('pg_temp.storage_frames')")
        .fetch_one(&pool)
        .await?;
    assert_eq!(
        parent, 0,
        "partitioned parent does not account for its children"
    );
    let expected: i64 = sqlx::query_scalar(
        r"SELECT pg_total_relation_size('pg_temp.storage_frames_old')
        +pg_total_relation_size('pg_temp.storage_frames_recent_a')
        +pg_total_relation_size('pg_temp.storage_frames_recent_default')",
    )
    .fetch_one(&pool)
    .await?;
    assert_eq!(actual, expected);
    assert!(actual > 0);
    let ordinary: i64 =
        sqlx::query_scalar("SELECT pg_total_relation_size('pg_temp.storage_ordinary')")
            .fetch_one(&pool)
            .await?;
    assert_eq!(
        tables
            .iter()
            .find(|t| t["name"] == "storage_ordinary")
            .unwrap()["bytes"],
        ordinary
    );
    let root = std::env::temp_dir().join(format!("vantyr-accounting-{}", Uuid::new_v4()));
    let day = root.join(Uuid::new_v4().to_string()).join("20260101");
    std::fs::create_dir_all(day.join("thumbs"))?;
    std::fs::write(day.join("retained.jpg"), vec![0; 12345])?;
    std::fs::write(day.join("orphan.jpg"), vec![0; 4567])?;
    std::fs::write(day.join("thumbs/cache.jpg"), vec![0; 2345])?;
    assert_eq!(std::fs::metadata(day.join("retained.jpg"))?.len(), 12345);
    let after = query_relation_storage(&pool, &schema).await?;
    assert_eq!(
        tables, after,
        "filesystem JPEG/orphan/cache bytes are outside DB accounting"
    );
    let report = storage_report(actual + ordinary + 8192, tables)?;
    assert_eq!(report["public_tables_bytes"], actual + ordinary);
    assert_eq!(report["other_bytes"], 8192);
    sqlx::raw_sql("DROP TABLE pg_temp.storage_frames_old")
        .execute(&pool)
        .await?;
    let after = query_relation_storage(&pool, &schema).await?;
    assert!(
        after
            .iter()
            .find(|t| t["name"] == "storage_frames")
            .unwrap()["bytes"]
            .as_i64()
            .unwrap()
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
    assert!(storage_report(
        1,
        vec![serde_json::json!({"name":"bad","bytes":"not bytes"})]
    )
    .is_err());
    assert!(storage_report(
        i64::MAX,
        vec![
            serde_json::json!({"bytes":i64::MAX}),
            serde_json::json!({"bytes":1})
        ]
    )
    .is_err());
    assert_eq!(
        storage_report(1, vec![serde_json::json!({"bytes":8192})]).unwrap()["other_bytes"],
        0
    );
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL; temporary PostgreSQL fixtures only"]
async fn ordinary_multiple_inheritance_is_counted_once_as_separate_relations() -> Result<()> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("TEST_DATABASE_URL")?)
        .await?;
    sqlx::raw_sql(r"
        CREATE TEMP TABLE inheritance_left(id INT);
        CREATE TEMP TABLE inheritance_right(id INT);
        CREATE TEMP TABLE inheritance_child(payload TEXT) INHERITS(inheritance_left,inheritance_right);
        CREATE INDEX ON inheritance_child(id);
        INSERT INTO inheritance_left VALUES(1);
        INSERT INTO inheritance_right VALUES(2);
        INSERT INTO inheritance_child SELECT n,md5(n::TEXT) FROM generate_series(1,1000) n;
    ").execute(&pool).await?;
    let schema: String =
        sqlx::query_scalar("SELECT nspname::text FROM pg_namespace WHERE oid=pg_my_temp_schema()")
            .fetch_one(&pool)
            .await?;
    let tables = query_relation_storage(&pool, &schema).await?;
    assert_eq!(tables.len(), 3);
    for table in &tables {
        let name = table["name"].as_str().unwrap();
        let expected:i64=sqlx::query_scalar("SELECT pg_total_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2")
            .bind(&schema).bind(name).fetch_one(&pool).await?;
        assert_eq!(table["bytes"], expected);
    }
    let expected:i64=sqlx::query_scalar("SELECT pg_total_relation_size('pg_temp.inheritance_left')+pg_total_relation_size('pg_temp.inheritance_right')+pg_total_relation_size('pg_temp.inheritance_child')")
        .fetch_one(&pool).await?;
    let report = storage_report(expected, tables)?;
    assert_eq!(report["public_tables_bytes"], expected);
    assert_eq!(report["other_bytes"], 0);
    Ok(())
}
