from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os


HOST = os.environ.get("WORLD_OROGEN_HOST", "127.0.0.1")
PORT = int(os.environ.get("WORLD_OROGEN_PORT", "8000"))
ROOT = Path(__file__).resolve().parent


class CleanUrlHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        route = path.split("?", 1)[0].split("#", 1)[0].rstrip("/")
        if route == "/import":
            path = "/import.html"
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer((HOST, PORT), CleanUrlHandler) as server:
        print(f"World Orogen is running at http://{HOST}:{PORT}/")
        print("Close this window or press Ctrl+C to stop the server.")
        server.serve_forever()
