import json
from pathlib import Path

import pytest
import import_uploads
from test_import_jobs import jobs, wait_job
from test_input_validation import _create_test_apkg_bytes
from models import Card


def create(client, headers, size, **options):
    response = client.post('/api/apkg/uploads', headers=headers,
                           json=dict(filename='sample.apkg', size=size, **options))
    assert response.status_code == 201, response.text
    return response.json()


def test_chunked_upload_preview_confirm_and_isolation(client, auth_headers_a, auth_headers_b, jobs, monkeypatch):
    monkeypatch.setattr(import_uploads, 'CHUNK_BYTES', 8192)
    package = _create_test_apkg_bytes(cards_count=2)
    state = create(client, auth_headers_a, len(package))
    path = f'/api/apkg/uploads/{state["id"]}'
    for method, suffix in [('GET',''), ('PUT','?offset=0'), ('POST','/finish'), ('DELETE','')]:
        response = client.request(method, path+suffix, headers=auth_headers_b)
        assert response.status_code == 404
    assert client.post(path+'/finish', headers=auth_headers_a).status_code == 409
    for offset in range(0,len(package),state['chunk_bytes']):
        chunk = package[offset:offset+state['chunk_bytes']]
        response = client.put(path, params={'offset':offset}, headers=auth_headers_a, content=chunk)
        assert response.status_code == 200, response.text
        assert response.json()['received'] == offset+len(chunk)
    assert client.get(path,headers=auth_headers_a).json()['received'] == len(package)
    response = client.post(path+'/finish', headers=auth_headers_a)
    assert response.status_code == 202,response.text
    job_id = response.json()['id']
    assert client.post(path+'/finish', headers=auth_headers_a).json()['id'] == job_id
    wait_job(client,job_id,auth_headers_a,{'awaiting_confirmation'})
    with jobs() as db: assert db.query(Card).count() == 0
    assert client.post(f'/api/apkg/jobs/{job_id}/confirm',headers=auth_headers_a).status_code == 202
    done = wait_job(client,job_id,auth_headers_a,{'completed'})
    assert done['result']['cards_imported'] == 2
    assert not (import_uploads.root()/state['id']/'package.apkg').exists()


def test_chunk_offset_bounds_and_cancellation(client,auth_headers_a,jobs,monkeypatch):
    monkeypatch.setattr(import_uploads, 'CHUNK_BYTES', 8)
    state=create(client,auth_headers_a,10)
    path=f'/api/apkg/uploads/{state["id"]}'
    assert client.put(path+'?offset=1',headers=auth_headers_a,content=b'abc').status_code==409
    assert client.put(path+'?offset=0',headers=auth_headers_a,content=b'123456789').status_code==413
    assert client.get(path,headers=auth_headers_a).json()['received']==0
    assert client.put(path+'?offset=0',headers=auth_headers_a,content=b'12345678').status_code==200
    assert client.put(path+'?offset=8',headers=auth_headers_a,content=b'abc').status_code==413
    assert client.get(path,headers=auth_headers_a).json()['received']==8
    assert (import_uploads.root()/state['id']/'package.apkg').read_bytes()==b'12345678'
    assert client.delete(path,headers=auth_headers_a).json()['status']=='cancelled'
    assert not (import_uploads.root()/state['id']/'package.apkg').exists()


def test_resume_truncates_unacknowledged_bytes(client,auth_headers_a,jobs):
    state=create(client,auth_headers_a,20)
    path=f'/api/apkg/uploads/{state["id"]}'
    assert client.put(path+'?offset=0',headers=auth_headers_a,content=b'12345').status_code==200
    package=import_uploads.root()/state['id']/'package.apkg'
    with package.open('ab') as stream:stream.write(b'part-of-interrupted-chunk')
    assert client.get(path,headers=auth_headers_a).json()['received']==5
    assert package.read_bytes()==b'12345'


def test_fast_upload_can_acknowledge_a_chunk_larger_than_one_mib(client, auth_headers_a, jobs):
    payload = b'package bytes' * (2 * 1024**2 // 13)
    assert len(payload) > 1024**2
    state = create(client, auth_headers_a, len(payload))
    path = f'/api/apkg/uploads/{state["id"]}'
    response = client.put(path, headers=auth_headers_a, content=payload)
    # Offset is required even for the first (large) request.
    assert response.status_code == 422
    response = client.put(path + '?offset=0', headers=auth_headers_a, content=payload)
    assert response.status_code == 200, response.text
    assert response.json()['received'] == len(payload)
    assert (import_uploads.root() / state['id'] / 'package.apkg').read_bytes() == payload


def test_chunk_write_failure_rolls_back(client,auth_headers_a,jobs,monkeypatch):
    state=create(client,auth_headers_a,20)
    path=f'/api/apkg/uploads/{state["id"]}'
    def no_space(*args):raise ValueError('Insufficient disk space')
    monkeypatch.setattr(import_uploads,'check_space',no_space)
    assert client.put(path+'?offset=0',headers=auth_headers_a,content=b'12345').status_code==400
    assert client.get(path,headers=auth_headers_a).json()['received']==0
    assert (import_uploads.root()/state['id']/'package.apkg').stat().st_size==0


def test_expiry_and_upload_limits(client,auth_headers_a,jobs,monkeypatch):
    import time
    state=create(client,auth_headers_a,20)
    directory=import_uploads.root()/state['id']
    state['updated_at']=time.time()-86401
    (directory/'status.json').write_text(json.dumps(state))
    assert client.get(f'/api/apkg/uploads/{state["id"]}',headers=auth_headers_a).json()['status']=='expired'
    assert not (directory/'package.apkg').exists()
    monkeypatch.setattr(import_uploads,'MAX_UPLOAD_BYTES',10)
    assert client.post('/api/apkg/uploads',headers=auth_headers_a,json={'filename':'big.apkg','size':11}).status_code==413
    assert client.post('/api/apkg/uploads',headers=auth_headers_a,json={'filename':'bad.exe','size':5}).status_code==400
    assert client.post('/api/apkg/uploads',headers=auth_headers_a,json={'filename':'all.colpkg','size':5}).status_code==400


def test_disconnected_request_rolls_back_without_internal_server_error(client,auth_headers_a,jobs,user_a):
    import asyncio
    from fastapi import HTTPException
    from starlette.requests import Request
    state=create(client,auth_headers_a,20)
    events=iter([{'type':'http.request','body':b'partial','more_body':True}, {'type':'http.disconnect'}])
    async def receive():return next(events)
    request=Request({'type':'http','method':'PUT','path':'/','headers':[]},receive)
    with pytest.raises(HTTPException) as error:
        asyncio.run(import_uploads.append(state['id'],user_a.id,0,request))
    assert error.value.status_code==408
    path=import_uploads.root()/state['id']/'package.apkg'
    assert path.stat().st_size==0
    assert client.get(f'/api/apkg/uploads/{state["id"]}',headers=auth_headers_a).json()['received']==0
