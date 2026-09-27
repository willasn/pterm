use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/// 持久化的连接配置。**敏感字段不在这里**——密码 / passphrase 存系统钥匙串。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// password | private_key | agent | auto
    pub auth_kind: String,
    /// 私钥路径（private_key 时有效）
    pub key_path: Option<String>,
    /// 分组名（connection_group 开关打开时可见）
    pub group_name: Option<String>,
    /// 是否在系统钥匙串中存有密码
    pub has_password: bool,
    /// 是否在系统钥匙串中存有私钥 passphrase
    pub has_passphrase: bool,
    /// 跳板机（ProxyJump）配置
    pub jump: Option<JumpRecord>,
    pub color: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JumpRecord {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: String,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub command: String,
    pub host: String,
    pub session_id: String,
    pub executed_at: String,
    /// 该命令累计执行次数。仅在去重查询时大于 1，其余情况为 1。
    pub uses: u32,
}

/// 命令历史的排序方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryOrder {
    /// 按最近执行倒序
    #[default]
    Recent,
    /// 按使用频率倒序，同频时按最近执行倒序
    Frequent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    /// 变量占位符名列表，如 ["host", "path"]
    pub variables: Vec<String>,
    pub group_name: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStateRecord {
    pub repo_path: String,
    pub last_sync_at: Option<String>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
}

// ---------------------------------------------------------------------------
// 系统钥匙串
// ---------------------------------------------------------------------------

pub mod secrets {
    use super::*;

    const SERVICE: &str = "com.pshell.desktop";

    fn entry(key: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(SERVICE, key).map_err(|e| AppError::Keyring(e.to_string()))
    }

    /// 写入敏感字段。成功写入系统钥匙串。
    pub fn set(key: &str, value: &str) -> AppResult<()> {
        entry(key)?
            .set_password(value)
            .map_err(|e| AppError::Keyring(format!("写入钥匙串失败：{e}")))
    }

    /// 读取敏感字段。不存在时返回 `None`，不视为错误。
    pub fn get(key: &str) -> AppResult<Option<String>> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(format!("读取钥匙串失败：{e}"))),
        }
    }

    pub fn delete(key: &str) -> AppResult<()> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(format!("删除钥匙串条目失败：{e}"))),
        }
    }

    /// 连接密码的钥匙串键名
    pub fn conn_password_key(conn_id: &str) -> String {
        format!("conn:{conn_id}:password")
    }

    /// 私钥 passphrase 的钥匙串键名
    pub fn conn_passphrase_key(conn_id: &str) -> String {
        format!("conn:{conn_id}:passphrase")
    }

    /// 跳板机密码的钥匙串键名
    pub fn jump_password_key(conn_id: &str) -> String {
        format!("conn:{conn_id}:jump-password")
    }

    /// AI 模型 API Key 的钥匙串键名。**不内置任何 Key**，完全由用户配置。
    /// 按模型条目的稳定 id 存储，因此一个模型一把 Key，可混合不同供应商。
    pub fn ai_model_key_key(model_id: &str) -> String {
        format!("ai:model:{model_id}:api_key")
    }

    /// 旧版「全局 AI Key」的键名。仅用于升级时把它迁移到第一个模型条目。
    pub fn legacy_ai_api_key_key() -> String {
        "ai:api_key".to_string()
    }

    /// Git 远端密码 / 访问令牌的钥匙串键名。**不内置任何凭据**，完全由用户配置。
    pub fn git_password_key(remote_name: &str) -> String {
        format!("git:{remote_name}:password")
    }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// 本地 SQLite 存储。连接由 `Mutex` 串行化访问，避免并发写冲突。
pub struct Store {
    conn: Mutex<Connection>,
}

pub type SharedStore = Arc<Store>;

impl Store {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).map_err(|e| AppError::Db(e.to_string()))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| AppError::Db(e.to_string()))?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    /// 仅供测试：在内存库上建同样的表结构，避免单测写盘。
    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| AppError::Db(e.to_string()))?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS connections (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                host          TEXT NOT NULL,
                port          INTEGER NOT NULL,
                username      TEXT NOT NULL,
                auth_kind     TEXT NOT NULL,
                key_path      TEXT,
                group_name    TEXT,
                has_password  INTEGER NOT NULL DEFAULT 0,
                has_passphrase INTEGER NOT NULL DEFAULT 0,
                jump_json     TEXT,
                color         TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS command_history (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                command      TEXT NOT NULL,
                host         TEXT NOT NULL,
                session_id   TEXT NOT NULL,
                executed_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_history_time
                ON command_history(executed_at DESC);

            CREATE TABLE IF NOT EXISTS snippets (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                content      TEXT NOT NULL,
                variables    TEXT NOT NULL DEFAULT '[]',
                group_name   TEXT,
                updated_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                repo_path     TEXT PRIMARY KEY,
                last_sync_at  TEXT,
                last_result   TEXT,
                last_error    TEXT
            );",
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }

    // -- 连接配置 ----------------------------------------------------------

    pub fn list_connections(&self) -> AppResult<Vec<StoredConnection>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, host, port, username, auth_kind, key_path, group_name,
                        has_password, has_passphrase, jump_json, color, created_at, updated_at
                 FROM connections ORDER BY group_name, name",
            )
            .map_err(|e| AppError::Db(e.to_string()))?;
        let rows = stmt
            .query_map([], |r| {
                let jump_json: Option<String> = r.get(10)?;
                Ok(StoredConnection {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    host: r.get(2)?,
                    port: r.get::<_, i64>(3)? as u16,
                    username: r.get(4)?,
                    auth_kind: r.get(5)?,
                    key_path: r.get(6)?,
                    group_name: r.get(7)?,
                    has_password: r.get::<_, i64>(8)? != 0,
                    has_passphrase: r.get::<_, i64>(9)? != 0,
                    jump: jump_json.and_then(|j| serde_json::from_str(&j).ok()),
                    color: r.get(11)?,
                    created_at: r.get(12)?,
                    updated_at: r.get(13)?,
                })
            })
            .map_err(|e| AppError::Db(e.to_string()))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Db(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn upsert_connection(&self, c: &StoredConnection) -> AppResult<()> {
        let jump_json = match &c.jump {
            Some(j) => Some(serde_json::to_string(j).map_err(|e| AppError::Other(e.to_string()))?),
            None => None,
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO connections
                (id, name, host, port, username, auth_kind, key_path, group_name,
                 has_password, has_passphrase, jump_json, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                host = excluded.host,
                port = excluded.port,
                username = excluded.username,
                auth_kind = excluded.auth_kind,
                key_path = excluded.key_path,
                group_name = excluded.group_name,
                has_password = excluded.has_password,
                has_passphrase = excluded.has_passphrase,
                jump_json = excluded.jump_json,
                color = excluded.color,
                updated_at = excluded.updated_at",
            params![
                c.id,
                c.name,
                c.host,
                c.port as i64,
                c.username,
                c.auth_kind,
                c.key_path,
                c.group_name,
                c.has_password as i64,
                c.has_passphrase as i64,
                jump_json,
                c.color,
                c.created_at,
                c.updated_at,
            ],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }

    /// 删除连接，并一并清理钥匙串中的敏感字段。
    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        {
            let conn = self.conn.lock();
            conn.execute("DELETE FROM connections WHERE id = ?1", params![id])
                .map_err(|e| AppError::Db(e.to_string()))?;
        }
        // 钥匙串清理失败不应阻断删除流程，仅记录
        for key in [
            secrets::conn_password_key(id),
            secrets::conn_passphrase_key(id),
            secrets::jump_password_key(id),
        ] {
            if let Err(e) = secrets::delete(&key) {
                log::warn!("清理钥匙串条目 {key} 失败：{e}");
            }
        }
        Ok(())
    }

    // -- 命令历史 ----------------------------------------------------------

    pub fn push_history(&self, command: &str, host: &str, session_id: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO command_history (command, host, session_id, executed_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                command,
                host,
                session_id,
                chrono::Local::now().to_rfc3339()
            ],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }

    pub fn list_history(
        &self,
        limit: u32,
        query: Option<&str>,
        dedupe: bool,
        order: HistoryOrder,
    ) -> AppResult<Vec<HistoryEntry>> {
        let conn = self.conn.lock();
        let like = format!("%{}%", query.unwrap_or(""));
        // 去重时用聚合子查询取每条命令的最近一次执行：保留原始行才能算准 uses
        let base = if dedupe {
            "SELECT h.id, h.command, h.host, h.session_id, h.executed_at, g.uses
             FROM command_history h
             JOIN (
                 SELECT command, COUNT(*) AS uses, MAX(id) AS last_id
                 FROM command_history
                 WHERE command LIKE ?1
                 GROUP BY command
             ) g ON h.id = g.last_id"
        } else {
            "SELECT id, command, host, session_id, executed_at, 1
             FROM command_history
             WHERE command LIKE ?1"
        };
        let order_clause = match (dedupe, order) {
            (true, HistoryOrder::Frequent) => "ORDER BY g.uses DESC, h.id DESC",
            (true, HistoryOrder::Recent) => "ORDER BY h.id DESC",
            (false, _) => "ORDER BY id DESC",
        };
        let sql = format!("{base}\n{order_clause} LIMIT ?2");

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::Db(e.to_string()))?;
        let rows = stmt
            .query_map(params![like, limit], |r| {
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    command: r.get(1)?,
                    host: r.get(2)?,
                    session_id: r.get(3)?,
                    executed_at: r.get(4)?,
                    uses: r.get(5)?,
                })
            })
            .map_err(|e| AppError::Db(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Db(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn clear_history(&self) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM command_history", [])
            .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }

    // -- 命令片段 ----------------------------------------------------------

    pub fn list_snippets(&self) -> AppResult<Vec<SnippetRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, content, variables, group_name, updated_at
                 FROM snippets ORDER BY group_name, name",
            )
            .map_err(|e| AppError::Db(e.to_string()))?;
        let rows = stmt
            .query_map([], |r| {
                let vars: String = r.get(4)?;
                Ok(SnippetRecord {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    content: r.get(3)?,
                    variables: serde_json::from_str(&vars).unwrap_or_default(),
                    group_name: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(|e| AppError::Db(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Db(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn upsert_snippet(&self, s: &SnippetRecord) -> AppResult<()> {
        let vars = serde_json::to_string(&s.variables).map_err(|e| AppError::Other(e.to_string()))?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO snippets (id, name, description, content, variables, group_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                content = excluded.content,
                variables = excluded.variables,
                group_name = excluded.group_name,
                updated_at = excluded.updated_at",
            params![
                s.id,
                s.name,
                s.description,
                s.content,
                vars,
                s.group_name,
                s.updated_at
            ],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])
            .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }

    // -- 同步状态 ----------------------------------------------------------

    pub fn sync_state(&self, repo_path: &str) -> AppResult<Option<SyncStateRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT repo_path, last_sync_at, last_result, last_error
                 FROM sync_state WHERE repo_path = ?1",
            )
            .map_err(|e| AppError::Db(e.to_string()))?;
        let mut rows = stmt
            .query_map(params![repo_path], |r| {
                Ok(SyncStateRecord {
                    repo_path: r.get(0)?,
                    last_sync_at: r.get(1)?,
                    last_result: r.get(2)?,
                    last_error: r.get(3)?,
                })
            })
            .map_err(|e| AppError::Db(e.to_string()))?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(|e| AppError::Db(e.to_string()))?)),
            None => Ok(None),
        }
    }

    pub fn set_sync_state(
        &self,
        repo_path: &str,
        result: Option<&str>,
        error: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO sync_state (repo_path, last_sync_at, last_result, last_error)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(repo_path) DO UPDATE SET
                last_sync_at = excluded.last_sync_at,
                last_result = excluded.last_result,
                last_error = excluded.last_error",
            params![
                repo_path,
                chrono::Local::now().to_rfc3339(),
                result,
                error
            ],
        )
        .map_err(|e| AppError::Db(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三条 ls -al + 一条 git status + 一条 pwd，共 5 条原始记录。
    fn seed(store: &Store) {
        for (command, host) in [
            ("ls -al", "a.example"),
            ("git status", "a.example"),
            ("ls -al", "b.example"),
            ("pwd", "a.example"),
            ("ls -al", "c.example"),
        ] {
            store.push_history(command, host, "s1").unwrap();
        }
    }

    #[test]
    fn dedupes_by_command_and_counts_uses() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);

        let rows = store
            .list_history(50, None, true, HistoryOrder::Recent)
            .unwrap();
        assert_eq!(rows.len(), 3);
        // 按最近执行倒序，去重后保留 ls -al 的最后一次执行
        assert_eq!(rows[0].command, "ls -al");
        assert_eq!(rows[0].uses, 3);
        assert_eq!(rows[0].host, "c.example");
        assert_eq!(rows[1].command, "pwd");
        assert_eq!(rows[2].command, "git status");
    }

    #[test]
    fn frequent_order_puts_most_used_first() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);

        let rows = store
            .list_history(50, None, true, HistoryOrder::Frequent)
            .unwrap();
        assert_eq!(rows[0].command, "ls -al");
        assert_eq!(rows[0].uses, 3);
        assert_eq!(rows[1].command, "pwd");
        assert_eq!(rows[2].command, "git status");
    }

    #[test]
    fn keeps_duplicates_when_dedupe_is_off() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);

        let rows = store
            .list_history(50, None, false, HistoryOrder::Recent)
            .unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].command, "ls -al");
        assert!(rows.iter().all(|r| r.uses == 1));
    }

    #[test]
    fn filters_by_substring() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);

        let rows = store
            .list_history(50, Some("git"), true, HistoryOrder::Recent)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "git status");
    }

    #[test]
    fn respects_limit() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);

        let rows = store
            .list_history(2, None, false, HistoryOrder::Recent)
            .unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn clear_history_empties_the_table() {
        let store = Store::open_in_memory().unwrap();
        seed(&store);

        store.clear_history().unwrap();
        let rows = store
            .list_history(50, None, false, HistoryOrder::Recent)
            .unwrap();
        assert!(rows.is_empty());
    }
}