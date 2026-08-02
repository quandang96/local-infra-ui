import logging
import os
import threading

from redash.query_runner import (
    TYPE_DATE,
    TYPE_DATETIME,
    TYPE_FLOAT,
    TYPE_INTEGER,
    TYPE_STRING,
    BaseSQLQueryRunner,
    InterruptException,
    JobTimeoutException,
    register,
)
from redash.settings import parse_boolean
from redash.utils import json_dumps, json_loads

try:
    import MySQLdb

    enabled = True
except ImportError:
    enabled = False

logger = logging.getLogger(__name__)
types_map = {
    0: TYPE_FLOAT,
    1: TYPE_INTEGER,
    2: TYPE_INTEGER,
    3: TYPE_INTEGER,
    4: TYPE_FLOAT,
    5: TYPE_FLOAT,
    7: TYPE_DATETIME,
    8: TYPE_INTEGER,
    9: TYPE_INTEGER,
    10: TYPE_DATE,
    12: TYPE_DATETIME,
    15: TYPE_STRING,
    16: TYPE_INTEGER,
    246: TYPE_FLOAT,
    253: TYPE_STRING,
    254: TYPE_STRING,
}


class Result(object):
    def __init__(self):
        pass


class Mysql(BaseSQLQueryRunner):
    noop_query = "SELECT 1"

    @classmethod
    def configuration_schema(cls):
        show_ssl_settings = parse_boolean(os.environ.get("MYSQL_SHOW_SSL_SETTINGS", "true"))
        schema = {
            "type": "object",
            "properties": {
                "host": {"type": "string", "default": "127.0.0.1"},
                "user": {"type": "string"},
                "passwd": {"type": "string", "title": "Password"},
                "db": {"type": "string", "title": "Database name"},
                "port": {"type": "number", "default": 3306},
            },
            "order": ["host", "port", "user", "passwd", "db"],
            "required": ["db"],
            "secret": ["passwd"],
        }

        if show_ssl_settings:
            schema["properties"].update(
                {
                    "use_ssl": {"type": "boolean", "title": "Use SSL"},
                    "ssl_cacert": {"type": "string", "title": "Path to CA certificate file to verify peer against (SSL)"},
                    "ssl_cert": {"type": "string", "title": "Path to client certificate file (SSL)"},
                    "ssl_key": {"type": "string", "title": "Path to private key file (SSL)"},
                }
            )

        return schema

    @classmethod
    def name(cls):
        return "MySQL"

    @classmethod
    def enabled(cls):
        return enabled

    def _connection(self):
        params = dict(
            host=self.configuration.get("host", ""),
            user=self.configuration.get("user", ""),
            passwd=self.configuration.get("passwd", ""),
            db=self.configuration["db"],
            port=self.configuration.get("port", 3306),
            charset="utf8",
            use_unicode=True,
            connect_timeout=60,
        )
        ssl_options = self._get_ssl_parameters()
        if ssl_options:
            params["ssl"] = ssl_options
        return MySQLdb.connect(**params)

    def _get_tables(self, schema):
        query = """
        SELECT col.table_schema as table_schema,
               col.table_name as table_name,
               col.column_name as column_name
        FROM `information_schema`.`columns` col
        WHERE col.table_schema NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys');
        """
        results, error = self.run_query(query, None)
        if error is not None:
            raise Exception("Failed getting schema.")

        for row in json_loads(results)["rows"]:
            table_name = (
                "{}.{}".format(row["table_schema"], row["table_name"])
                if row["table_schema"] != self.configuration["db"]
                else row["table_name"]
            )
            if table_name not in schema:
                schema[table_name] = {"name": table_name, "columns": []}
            schema[table_name]["columns"].append(row["column_name"])
        return list(schema.values())

    def run_query(self, query, user):
        event = threading.Event()
        thread_id = ""
        result = Result()
        thread = None
        try:
            connection = self._connection()
            thread_id = connection.thread_id()
            thread = threading.Thread(target=self._run_query, args=(query, user, connection, result, event))
            thread.start()
            while not event.wait(1):
                pass
        except (KeyboardInterrupt, InterruptException, JobTimeoutException):
            self._cancel(thread_id)
            if thread:
                thread.join()
            raise
        return result.json_data, result.error

    def _run_query(self, query, user, connection, result, event):
        cursor = None
        try:
            cursor = connection.cursor()
            logger.debug("MySQL running query: %s", query)
            cursor.execute(query)
            data = cursor.fetchall()
            description = cursor.description
            while cursor.nextset():
                if cursor.description is not None:
                    data = cursor.fetchall()
                    description = cursor.description

            if description is not None:
                columns = self.fetch_columns([(item[0], types_map.get(item[1])) for item in description])
                result.json_data = json_dumps(
                    {"columns": columns, "rows": [dict(zip((column["name"] for column in columns), row)) for row in data]}
                )
                result.error = None
            else:
                result.json_data = None
                result.error = "No data was returned."
            cursor.close()
        except MySQLdb.Error as error:
            if cursor:
                cursor.close()
            result.json_data = None
            result.error = error.args[1]
        finally:
            event.set()
            connection.close()

    def _get_ssl_parameters(self):
        if not self.configuration.get("use_ssl"):
            return None
        ssl_params = {}
        for key, config_key in {"ssl_cacert": "ca", "ssl_cert": "cert", "ssl_key": "key"}.items():
            value = self.configuration.get(key)
            if value:
                ssl_params[config_key] = value
        return ssl_params

    def _cancel(self, thread_id):
        connection = None
        cursor = None
        error = None
        try:
            connection = self._connection()
            cursor = connection.cursor()
            cursor.execute("KILL %d" % thread_id)
        except MySQLdb.Error as exception:
            if cursor:
                cursor.close()
            error = exception.args[1]
        finally:
            if connection:
                connection.close()
        return error


class RDSMySQL(Mysql):
    @classmethod
    def name(cls):
        return "MySQL (Amazon RDS)"

    @classmethod
    def type(cls):
        return "rds_mysql"

    @classmethod
    def configuration_schema(cls):
        return {
            "type": "object",
            "properties": {
                "host": {"type": "string"},
                "user": {"type": "string"},
                "passwd": {"type": "string", "title": "Password"},
                "db": {"type": "string", "title": "Database name"},
                "port": {"type": "number", "default": 3306},
                "use_ssl": {"type": "boolean", "title": "Use SSL"},
            },
            "order": ["host", "port", "user", "passwd", "db"],
            "required": ["db", "user", "passwd", "host"],
            "secret": ["passwd"],
        }

    def _get_ssl_parameters(self):
        if self.configuration.get("use_ssl"):
            return {"ca": os.path.join(os.path.dirname(__file__), "./files/rds-combined-ca-bundle.pem")}
        return None


register(Mysql)
register(RDSMySQL)
