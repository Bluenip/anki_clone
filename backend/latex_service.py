"""Stand-alone LaTeX compiler for Docker (`latex` service in docker-compose.yml).

It has no database, media or network access of its own; the backend sends TeX source and gets a PNG
back. The bubblewrap sandbox inside it needs user namespaces, so only this container is granted them.
"""
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from latex_rendering import compile_local, local_available

app = FastAPI(title='LaTeX renderer', docs_url=None, redoc_url=None, openapi_url=None)


class Source(BaseModel):
    body: str = Field(max_length=100000)
    header: str = Field(max_length=100000)
    footer: str = Field(max_length=100000)


@app.post('/compile')
async def compile_source(source: Source):
    try:
        data = await run_in_threadpool(compile_local, source.body, source.header, source.footer)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    return Response(data, media_type='image/png')


@app.get('/health')
def health():
    return {'available': local_available()}
