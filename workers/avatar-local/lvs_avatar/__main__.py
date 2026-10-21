import os

import uvicorn

from .server import create_app


def main() -> None:
    host = os.environ.get("LVS_AVATAR_HOST", "127.0.0.1")
    port = int(os.environ.get("LVS_AVATAR_PORT", "8765"))
    uvicorn.run(create_app(), host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
