"""Start Touchline locally:  python run.py   then open http://127.0.0.1:8000"""
import os

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Touchline is running at http://127.0.0.1:{port}  (Ctrl+C to stop)")
    # No auto-reloader: one process per launch, so stopping it never leaves a stray server behind.
    uvicorn.run("server.main:app", host="127.0.0.1", port=port, reload=False)
