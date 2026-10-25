"""Stand-in for gradio: upstream tools/my_utils.py imports it only to show WebUI warnings."""


def Warning(*args, **kwargs):  # noqa: N802 - mirrors gradio's API
    print("warning:", *args, flush=True)
