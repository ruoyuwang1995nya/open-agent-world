import json
from pathlib import Path
import runpy

import pytest

ROOT = Path(__file__).resolve().parents[2]
configure = runpy.run_path(str(ROOT / 'scripts/configure-desktop-release.py'))['configure']
updates = runpy.run_path(str(ROOT / 'scripts/collect-desktop-update.py'))
collect, manifest = updates['collect'], updates['manifest']
TARGETS = updates['TARGETS']
KEYS = {'OAW_UPDATER_PUBLIC_KEY': 'public-key', 'TAURI_SIGNING_PRIVATE_KEY': 'private-key'}


@pytest.fixture
def release_root(tmp_path):
    folder = tmp_path / 'desktop/src-tauri'
    folder.mkdir(parents=True)
    (folder / 'tauri.conf.json').write_text(json.dumps({
        'version': '1.2.3', 'bundle': {'windows': {'nsis': {'installMode': 'currentUser'}}},
    }))
    (folder / 'tauri.macos.conf.json').write_text(json.dumps({
        'bundle': {'macOS': {'signingIdentity': '-', 'minimumSystemVersion': '12.0'}},
    }))
    return tmp_path


@pytest.mark.parametrize('env', [
    {'OAW_SIGNED_RELEASE': 'true'},
    {'OAW_UPDATER_PUBLIC_KEY': 'public'},
    {'TAURI_SIGNING_PRIVATE_KEY': 'private'},
])
def test_signed_release_rejects_incomplete_keys(tmp_path, env):
    with pytest.raises(SystemExit, match='both updater'):
        configure(tmp_path, env)


def test_release_config_contains_only_public_key_and_enables_build(release_root):
    envfile = release_root / 'env'
    configure(release_root, {**KEYS, 'GITHUB_ENV': str(envfile)})
    content = (release_root / 'desktop/src-tauri/tauri.conf.json').read_text()
    config = json.loads(content)
    assert config['bundle']['createUpdaterArtifacts'] is True
    assert config['plugins']['updater']['pubkey'] == 'public-key'
    assert 'private-key' not in content
    assert envfile.read_text() == 'OAW_UPDATER_ENABLED=1\n'


@pytest.mark.parametrize('platform, error', [('Windows', 'code-signing'), ('macOS', 'notarization')])
def test_strict_release_requires_platform_credentials_without_modifying_config(release_root, platform, error):
    path = release_root / 'desktop/src-tauri/tauri.conf.json'
    original = path.read_bytes()
    with pytest.raises(SystemExit, match=error):
        configure(release_root, {**KEYS, 'OAW_SIGNED_RELEASE': 'true', 'RUNNER_OS': platform})
    assert path.read_bytes() == original


@pytest.mark.parametrize('platform', ['Windows', 'macOS'])
def test_preview_after_signed_build_clears_release_only_configuration(release_root, platform):
    env = {**KEYS, 'RUNNER_OS': platform, 'OAW_SIGNED_RELEASE': 'true',
           'OAW_WINDOWS_CERTIFICATE_THUMBPRINT': 'certificate-thumbprint',
           'APPLE_CERTIFICATE': 'private-certificate', 'APPLE_SIGNING_IDENTITY': 'Developer ID: Test',
           'APPLE_ID': 'account', 'APPLE_PASSWORD': 'private-password', 'APPLE_TEAM_ID': 'team'}
    configure(release_root, env)
    config_path = release_root / 'desktop/src-tauri/tauri.conf.json'
    signed = json.loads(config_path.read_text())
    assert signed['bundle']['createUpdaterArtifacts'] is True
    if platform == 'Windows':
        assert signed['bundle']['windows']['certificateThumbprint'] == 'certificate-thumbprint'
    else:
        mac = json.loads((release_root / 'desktop/src-tauri/tauri.macos.conf.json').read_text())
        assert mac['bundle']['macOS']['signingIdentity'] == 'Developer ID: Test'
    envfile = release_root / 'env'
    configure(release_root, {'RUNNER_OS': platform, 'GITHUB_ENV': str(envfile)})
    preview = json.loads(config_path.read_text())
    assert 'updater' not in preview.get('plugins', {})
    assert 'createUpdaterArtifacts' not in preview['bundle']
    assert preview['bundle']['windows']['nsis']['installMode'] == 'currentUser'
    assert envfile.read_text() == 'OAW_UPDATER_ENABLED=0\n'
    if platform == 'Windows':
        assert 'certificateThumbprint' not in preview['bundle']['windows']
    else:
        mac = json.loads((release_root / 'desktop/src-tauri/tauri.macos.conf.json').read_text())
        assert mac['bundle']['macOS'] == {'signingIdentity': '-', 'minimumSystemVersion': '12.0'}
    assert 'private-' not in config_path.read_text()


@pytest.fixture
def collected(release_root):
    bundle = release_root / 'desktop/src-tauri/target/release/bundle'
    for platform in TARGETS:
        folder = bundle / platform
        folder.mkdir(parents=True)
        # Each platform build contains only its own output. Collect in turn.
        name = 'app.exe' if platform == 'windows-x64' else 'app.app.tar.gz'
        (folder / name).write_bytes(b'updater payload')
        signature = folder / (name + '.sig')
        signature.write_text('signature-' + platform + '\n')
        collect(release_root, platform)
        signature.unlink()
    return release_root / 'release-assets'


def test_manifest_matches_collected_payloads_for_all_platforms(collected):
    manifest(collected)
    value = json.loads((collected / 'latest.json').read_text())
    assert value['version'] == '1.2.3'
    assert set(value['platforms']) == set(TARGETS.values())
    for platform, target in TARGETS.items():
        entry = value['platforms'][target]
        name = entry['url'].rsplit('/', 1)[1]
        assert entry['url'].startswith('https://github.com/theAfish/open-agent-world/releases/download/v1.2.3/')
        assert (collected / name).read_bytes() == b'updater payload'
        assert entry['signature'] == (collected / (name + '.sig')).read_text().strip()


@pytest.mark.parametrize('damage', [
    'missing-platform', 'different-version', 'wrong-platform', 'extra-platform',
    'missing-payload', 'empty-payload', 'missing-signature', 'wrong-signature', 'wrong-url',
])
def test_manifest_rejects_incomplete_or_inconsistent_release(collected, damage):
    path = collected / 'updater-windows-x64.json'
    value = json.loads(path.read_text())
    entry = value['platforms']['windows-x86_64']
    artifact = collected / entry['url'].rsplit('/', 1)[1]
    if damage == 'different-version':
        value['version'] = '1.2.4'
    elif damage == 'wrong-platform':
        value['platforms'] = {'darwin-x86_64': entry}
    elif damage == 'extra-platform':
        value['platforms']['darwin-x86_64'] = entry
    elif damage == 'missing-payload':
        artifact.unlink()
    elif damage == 'empty-payload':
        artifact.write_bytes(b'')
    elif damage == 'missing-signature':
        artifact.with_name(artifact.name + '.sig').unlink()
    elif damage == 'wrong-signature':
        entry['signature'] = 'different-signature'
    elif damage == 'wrong-url':
        entry['url'] = 'https://example.com/unrelated.exe'
    path.write_text(json.dumps(value))
    if damage == 'missing-platform':
        path.unlink()
    with pytest.raises((ValueError, FileNotFoundError)):
        manifest(collected)
    assert not (collected / 'latest.json').exists()


@pytest.mark.parametrize('damage', ['no-signature', 'empty-signature', 'no-payload', 'empty-payload', 'multiple'])
def test_collect_rejects_invalid_updater_outputs(release_root, damage):
    folder = release_root / 'desktop/src-tauri/target/release/bundle/nsis'
    folder.mkdir(parents=True)
    if damage != 'no-signature':
        (folder / 'app.exe.sig').write_text('' if damage == 'empty-signature' else 'signature')
    if damage != 'no-payload':
        (folder / 'app.exe').write_bytes(b'' if damage == 'empty-payload' else b'payload')
    if damage == 'multiple':
        (folder / 'other.exe.sig').write_text('signature')
    with pytest.raises(ValueError):
        collect(release_root, 'windows-x64')
    assert not (release_root / 'release-assets/updater-windows-x64.json').exists()
