import os
import unittest
from unittest.mock import patch

from eval.rag.metrics import ragas_judge


class RagasJudgeConfigTests(unittest.TestCase):
    def test_split_judge_and_embedding_config_take_precedence(self):
        env = {
            "AIHUBMIX_API_KEY": "legacy-key",
            "AIHUBMIX_BASE_URL": "https://legacy.example/v1",
            "JUDGE_API_KEY": "judge-key",
            "JUDGE_BASE_URL": "https://judge.example/v1",
            "JUDGE_MODEL": "gpt-5.5",
            "EMBEDDING_API_KEY": "embedding-key",
            "EMBEDDING_BASE_URL": "https://api.siliconflow.cn/v1",
            "EMBEDDING_MODEL": "Qwen/Qwen3-Embedding-8B",
        }

        with patch.dict(os.environ, env, clear=True):
            config = ragas_judge._load_provider_config()

        self.assertEqual(config.judge_api_key, "judge-key")
        self.assertEqual(config.judge_base_url, "https://judge.example/v1")
        self.assertEqual(config.judge_model, "gpt-5.5")
        self.assertEqual(config.embedding_api_key, "embedding-key")
        self.assertEqual(config.embedding_base_url, "https://api.siliconflow.cn/v1")
        self.assertEqual(config.embedding_model, "Qwen/Qwen3-Embedding-8B")

    def test_legacy_aihubmix_config_still_drives_both_clients(self):
        env = {
            "AIHUBMIX_API_KEY": "legacy-key",
            "AIHUBMIX_BASE_URL": "https://legacy.example/v1",
        }

        with patch.dict(os.environ, env, clear=True):
            config = ragas_judge._load_provider_config()

        self.assertEqual(config.judge_api_key, "legacy-key")
        self.assertEqual(config.judge_base_url, "https://legacy.example/v1")
        self.assertEqual(config.judge_model, "gpt-5.4-mini")
        self.assertEqual(config.embedding_api_key, "legacy-key")
        self.assertEqual(config.embedding_base_url, "https://legacy.example/v1")
        self.assertEqual(config.embedding_model, "text-embedding-3-large")

    def test_siliconflow_embedding_defaults_when_key_is_available(self):
        env = {
            "JUDGE_API_KEY": "judge-key",
            "JUDGE_BASE_URL": "https://judge.example/v1",
            "SILICONFLOW_API_KEY": "silicon-key",
        }

        with patch.dict(os.environ, env, clear=True):
            config = ragas_judge._load_provider_config()

        self.assertEqual(config.embedding_api_key, "silicon-key")
        self.assertEqual(config.embedding_base_url, "https://api.siliconflow.cn/v1")
        self.assertEqual(config.embedding_model, "Qwen/Qwen3-Embedding-8B")

    def test_siliconflow_key_can_drive_judge_and_embedding(self):
        env = {
            "SILICONFLOW_API_KEY": "silicon-key",
        }

        with patch.dict(os.environ, env, clear=True):
            config = ragas_judge._load_provider_config()

        self.assertEqual(config.judge_api_key, "silicon-key")
        self.assertEqual(config.judge_base_url, "https://api.siliconflow.cn/v1")
        self.assertEqual(config.judge_model, "deepseek-ai/DeepSeek-V3.2")
        self.assertEqual(config.embedding_api_key, "silicon-key")
        self.assertEqual(config.embedding_base_url, "https://api.siliconflow.cn/v1")
        self.assertEqual(config.embedding_model, "Qwen/Qwen3-Embedding-8B")


if __name__ == "__main__":
    unittest.main()
