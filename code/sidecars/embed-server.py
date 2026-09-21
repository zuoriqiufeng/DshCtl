#!/usr/bin/env python
"""embed-server.py — BGE embedding sidecar for DSH ops-agent（阶段3）

与 Hermes 共用同一模型（BAAI/bge-large-zh-v1.5, 1024d）与同一 venv（sentence-transformers），
保证两侧向量完全一致。裸 http.server 实现，无框架依赖。

运行：
    HF_HOME=/hdd/demo/public/chunk/HuggingFace HF_HUB_OFFLINE=1 \
      /hdd/demo/public/venv/bin/python embed-server.py --port 8096

接口：
    GET  /health  → {"status":"ok","model":...,"loaded":bool}
    POST /embed   {"input": ["text", ...]} → {"data":[{"embedding":[...]}, ...], "model":...}
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = os.environ.get('EMBED_MODEL_NAME', 'BAAI/bge-large-zh-v1.5')
HF_HOME = os.environ.get('EMBED_HF_HOME', '/hdd/demo/public/chunk/HuggingFace')
MAX_TEXTS = 64

_model = None


def get_model():
    """懒加载模型（与 Hermes supplement._get_embedding_model 同参：CPU, 默认 encode）。"""
    global _model
    if _model is None:
        os.environ.setdefault('HF_HOME', HF_HOME)
        os.environ.setdefault('HF_HUB_OFFLINE', '1')
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME, device='cpu')
    return _model


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            self._send(200, {'status': 'ok', 'model': MODEL_NAME, 'loaded': _model is not None})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/embed'):
            self._send(404, {'error': 'not found'})
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(n).decode('utf-8'))
            texts = data.get('input') or []
            if isinstance(texts, str):
                texts = [texts]
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                self._send(400, {'error': '"input" must be string or list[str]'})
                return
            if len(texts) > MAX_TEXTS:
                self._send(400, {'error': f'too many texts (max {MAX_TEXTS})'})
                return
            model = get_model()
            vectors = model.encode(texts).tolist()
            self._send(200, {'data': [{'embedding': v} for v in vectors], 'model': MODEL_NAME})
        except Exception as e:  # noqa: BLE001 — sidecar 崩溃恢复
            try:
                self._send(500, {'error': str(e)[:200]})
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8096)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    # 启动即预载模型，避免首个请求承担加载延迟
    get_model()
    print(f'[embed-server] {MODEL_NAME} loaded, listening on {args.host}:{args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
