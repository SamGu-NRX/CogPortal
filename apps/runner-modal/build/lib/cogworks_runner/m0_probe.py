"""Manual Modal feasibility probe. Run only in a configured Modal workspace."""

import modal

app = modal.App("cogworks-runner-m0")


@app.local_entrypoint()
def main() -> None:
    image = modal.Image.debian_slim(python_version="3.11")
    sandbox = modal.Sandbox.create(
        "python",
        "-c",
        "import urllib.request; urllib.request.urlopen('https://example.com', timeout=2)",
        image=image,
        app=app,
        block_network=True,
        cpu=(0.25, 0.5),
        memory=(128, 256),
        timeout=10,
    )
    try:
        sandbox.wait()
        if sandbox.returncode == 0:
            raise RuntimeError("M0 failed: evaluation sandbox reached the public network.")
        print("M0 network isolation passed.")
    finally:
        sandbox.terminate()
