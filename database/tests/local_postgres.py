"""Disposable database on an explicitly configured loopback PostgreSQL test service.

The standard PostgreSQL service is used for XML tests because the embedded test
binary omits libxml. Never accepts a non-loopback host or reuses an existing DB.
"""
import atexit
import uuid
from urllib.parse import urlparse
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo


def create_database(service_url):
    parsed = urlparse(service_url)
    if parsed.hostname not in {'localhost', '127.0.0.1', '::1'}:
        raise ValueError('FOODFLOW_TEST_POSTGRES_URL must use a loopback test service')
    name = 'foodflow_test_' + uuid.uuid4().hex
    control = psycopg.connect(service_url, autocommit=True)
    control.execute(sql.SQL('create database {}').format(sql.Identifier(name)))
    uri = make_conninfo(service_url, dbname=name)

    def cleanup():
        try:
            # Only the random database created above, never the configured database.
            control.execute(sql.SQL('drop database {} with (force)').format(sql.Identifier(name)))
        finally:
            control.close()
    atexit.register(cleanup)
    return control, uri
