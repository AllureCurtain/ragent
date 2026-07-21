-- ragent v1.4 -> v1.5 升级脚本
-- 会话消息新增「回答来源」列（文档级来源列表 JSON，用于来源面板与预览）

ALTER TABLE t_message ADD COLUMN IF NOT EXISTS sources JSONB;

COMMENT ON COLUMN t_message.sources IS '回答来源';
