from xml.etree.ElementTree import fromstring


def test_signed_apk_smoke_does_not_accept_blank_webview_or_native_error():
    import pytest

    from distribution.android_release_smoke import ui_ready

    loading = fromstring(
        '<hierarchy><node text="Starting the offline app…"/><node class="android.webkit.WebView" package="example.app"/></hierarchy>'
    )
    assert not ui_ready(loading, "example.app")
    failed = fromstring(
        '<hierarchy><node text="The offline service could not start. Your saved data has not been removed."/><node class="android.webkit.WebView" package="example.app"/></hierarchy>'
    )
    with pytest.raises(RuntimeError):
        ui_ready(failed, "example.app")
    ready = fromstring(
        '<hierarchy><node text="App"/><node class="android.webkit.WebView" package="example.app"><node text="A real application page with useful content"/><node text="Open" clickable="true"/></node></hierarchy>'
    )
    assert ui_ready(ready, "example.app")
    assert not ui_ready(ready, "wrong.app")
