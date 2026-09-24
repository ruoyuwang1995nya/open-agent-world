"""OAW wiring for the knowledge base card: registration, errors and lifecycle.

The pipeline itself is covered by ``plugins/knowledge_base/tests``, which runs with
no host at all. What is left for the backend to prove is the seam: that the loader
registers the card, that the three human-only operations stay unreachable by agents,
that a ``KnowledgeError`` out of a handler becomes a ``ResourceValidationError``
without any adapter in between, and that create/delete own the storage directory.
"""
import base64
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PLUGIN_SRC = Path(__file__).resolve().parents[2] / "plugins" / "knowledge_base" / "src"
if str(PLUGIN_SRC) not in sys.path:
    sys.path.insert(0, str(PLUGIN_SRC))

pytest.importorskip("mkb", reason="Install mat-know-base into the backend environment")
pytest.importorskip("sqlalchemy")

from backend.config import Settings  # noqa: E402
from backend.errors import ResourceValidationError  # noqa: E402
from backend.main import create_app  # noqa: E402
from backend.node_resources import ResourceActionRequest, invoke_resource_action  # noqa: E402
from backend.plugins.loader import load_plugin_registry  # noqa: E402
from backend.services import create_services  # noqa: E402
from backend.tests.conftest import create_node  # noqa: E402
from backend.world.models import CardCreate  # noqa: E402
from oaw_knowledge_base.errors import KnowledgeError  # noqa: E402
from oaw_knowledge_base.operations import EXTRACT_ACTIONS, OPERATIONS, READ_ACTIONS  # noqa: E402

NODE_TYPE = "knowledge.base"
# Uploading a file, changing settings and approving a draft are acts a person takes
# on the canvas. They must never gain a capability kind, on any transport.
DESKTOP_ONLY = {"ingest", "settings", "review"}


@pytest.fixture
def services(tmp_path):
    instance = create_services(Settings.for_data_root(tmp_path / "profile"))
    yield instance
    instance.close()


async def action(services, node_id, operation, **arguments):
    return await invoke_resource_action(services, node_id, operation,
                                        ResourceActionRequest(arguments=arguments))


def test_the_loader_registers_the_card_and_its_grants():
    registry = load_plugin_registry()
    definition = registry.node_type(NODE_TYPE)
    assert definition.frontend["workspace"] == "workspace"
    assert definition.deletion_warning  # deleting a card destroys knowledge; warn first
    assert set(definition.resource_actions) == {operation.name for operation in OPERATIONS}

    for name, resource_action in definition.resource_actions.items():
        if name in DESKTOP_ONLY:
            assert resource_action.capability_kind is None, f"{name} is reachable by agents"
            continue
        capability = registry.capability_definition(resource_action.capability_kind)
        assert capability.tool_name and capability.input_schema["type"] == "object"

    read = {grant.kind for grant in registry.relationship(f"{NODE_TYPE}.read").capabilities}
    extract = {grant.kind for grant in registry.relationship(f"{NODE_TYPE}.extract").capabilities}
    assert read == {f"{NODE_TYPE}.{name}" for name in READ_ACTIONS}
    assert extract == {f"{NODE_TYPE}.{name}" for name in EXTRACT_ACTIONS}
    assert read < extract  # extract is read plus the write half, never less
    assert not {kind for kind in extract if kind.rsplit(".", 1)[-1] in DESKTOP_ONLY}


@pytest.mark.asyncio
async def test_a_knowledge_error_surfaces_as_a_validation_error(services):
    node = await services.create_card(CardCreate(type=NODE_TYPE))
    # The conversion needs no adapter: the plugin raises its own KnowledgeError, the
    # host turns any ValueError out of a handler into a ResourceValidationError.
    assert issubclass(KnowledgeError, ValueError)
    with pytest.raises(ResourceValidationError) as failure:
        await action(services, node.id, "markdown", source_id="not-a-uuid")
    assert "UUID" in str(failure.value)


@pytest.mark.asyncio
async def test_an_mkb_refusal_does_not_reach_the_browser_as_a_crash(services):
    node = await services.create_card(CardCreate(type=NODE_TYPE))
    # MKB's exceptions are not ValueErrors, so without the plugin's guard asking for a
    # well-formed id that does not exist would leave the handler as a 500.
    with pytest.raises(ResourceValidationError) as failure:
        await action(services, node.id, "projections",
                     projection_id="00000000-0000-0000-0000-000000000000")
    assert "not found" in str(failure.value).lower()


@pytest.mark.asyncio
async def test_create_and_delete_own_the_storage_directory(services):
    node = await services.create_card(CardCreate(type=NODE_TYPE))
    storage = services.resources.node_storage_path(node.id)
    assert (storage / "knowledge.db").exists()  # created eagerly, not on first action

    await action(services, node.id, "ingest", filename="note.md",
                 content_base64=base64.b64encode(b"# Note\n\ntext").decode(),
                 media_type="text/markdown")
    await services.delete_card(node.id)
    assert not storage.exists()


def test_the_card_survives_a_restart(data_root):
    settings = Settings.for_data_root(data_root)
    with TestClient(create_app(settings)) as client:
        assert NODE_TYPE in {item["id"] for item in client.get("/api/catalog").json()["node_types"]}
        node = create_node(client, NODE_TYPE)
        url = f"/api/nodes/{node['id']}/resource/"
        assert client.post(url + "settings", json={"arguments": {"collection_name": "Alloys"}}).status_code == 200
        upload = client.post(url + "ingest", json={"arguments": {
            "filename": "note.md", "media_type": "text/markdown",
            "content_base64": base64.b64encode(b"# Note\n\nSome text.").decode()}})
        assert upload.status_code == 200, upload.text

    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/nodes/{node['id']}").json()["status"] == "available"
        overview = client.post(url + "overview", json={"arguments": {}})
        assert overview.status_code == 200, overview.text
        assert overview.json()["collection"]["name"] == "Alloys"
        assert overview.json()["counts"]["sources"] == 1
        # A bad argument is a 422 with the plugin's own message, not a 500.
        bad = client.post(url + "markdown", json={"arguments": {"source_id": "nope"}})
        assert bad.status_code == 422, bad.text
        assert client.delete(f"/api/nodes/{node['id']}").status_code == 200
