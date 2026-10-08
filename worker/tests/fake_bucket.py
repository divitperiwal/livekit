"""A local stand-in for an S3-compatible bucket: stores PUTs, refuses keys ending denied.ogg."""

from dataclasses import dataclass, field

from aiohttp import web


@dataclass
class FakeBucket:
    requests: list[web.Request] = field(default_factory=list)
    objects: dict[str, bytes] = field(default_factory=dict)
    endpoint: str = ""

    @property
    def app(self) -> web.Application:
        app = web.Application()
        app.router.add_route("PUT", "/{tail:.*}", self._put)
        return app

    async def _put(self, request: web.Request) -> web.Response:
        self.requests.append(request)
        if request.path.endswith("/denied.ogg"):
            return web.Response(status=403, text="<Error><Code>AccessDenied</Code></Error>")
        self.objects[request.raw_path] = await request.read()
        return web.Response(status=200)
