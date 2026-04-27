#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import posixpath
import sqlite3
import sys
from dataclasses import dataclass
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
HOST = os.environ.get("TRIMRR_HOST", "0.0.0.0")
PORT = int(os.environ.get("TRIMRR_PORT", "6969"))


@dataclass(frozen=True)
class MediaService:
    source: str
    config_path: Path
    default_port: int

    def load(self) -> dict[str, Any]:
        if not self.config_path.exists():
            raise FileNotFoundError(f"Missing config for {self.source}: {self.config_path}")

        root = ET.fromstring(self.config_path.read_text())
        enable_ssl = (root.findtext("EnableSsl") or "False").strip().lower() == "true"
        bind_address = (root.findtext("BindAddress") or "*").strip()
        port = int((root.findtext("SslPort") if enable_ssl else root.findtext("Port")) or self.default_port)
        api_key = (root.findtext("ApiKey") or "").strip()
        url_base = (root.findtext("UrlBase") or "").strip().strip("/")

        if not api_key:
            raise RuntimeError(f"{self.source} API key missing in {self.config_path}")

        host = "127.0.0.1" if bind_address in {"", "*"} else bind_address
        scheme = "https" if enable_ssl else "http"
        base_url = f"{scheme}://{host}:{port}/"
        if url_base:
            base_url = urljoin(base_url, f"{url_base}/")

        return {"source": self.source, "api_key": api_key, "base_url": base_url}


SERVICES = {
    "radarr": MediaService("radarr", Path("/var/lib/radarr/config.xml"), 7878),
    "sonarr": MediaService("sonarr", Path("/var/lib/sonarr/config.xml"), 8989),
}

DATABASES = {
    "radarr": Path("/var/lib/radarr/radarr.db"),
    "sonarr": Path("/var/lib/sonarr/sonarr.db"),
}


def service_config(source: str) -> dict[str, Any]:
    if source not in SERVICES:
        raise ValueError(f"Unsupported source: {source}")
    return SERVICES[source].load()


def api_request(
    source: str,
    method: str,
    path: str,
    *,
    query: dict[str, Any] | None = None,
    body: Any | None = None,
    accept: str = "application/json",
) -> tuple[int, bytes, dict[str, str]]:
    config = service_config(source)
    url = urljoin(config["base_url"], path.lstrip("/"))
    if query:
        query_string = urlencode([(key, str(value)) for key, value in query.items()], doseq=True)
        url = f"{url}?{query_string}"

    data = None
    headers = {
        "X-Api-Key": config["api_key"],
        "Accept": accept,
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urlopen(request, timeout=60) as response:
            return response.status, response.read(), dict(response.headers.items())
    except HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers.items())
    except URLError as exc:
        raise RuntimeError(f"{source} request failed: {exc}") from exc


def api_json(source: str, method: str, path: str, **kwargs: Any) -> Any:
    status, payload, _headers = api_request(source, method, path, **kwargs)
    if status >= 400:
        detail = payload.decode("utf-8", errors="replace")
        raise RuntimeError(f"{source} {method} {path} failed with {status}: {detail}")
    if not payload:
        return None
    return json.loads(payload.decode("utf-8"))


def poster_path(item: dict[str, Any], source: str) -> str | None:
    for image in item.get("images") or []:
        if image.get("coverType") != "poster":
            continue
        if image.get("url"):
            image_path = image["url"]
            return f"/api/poster?source={quote(source)}&path={quote(image_path, safe='')}"
        if image.get("remoteUrl"):
            return image["remoteUrl"]
    return None


def parse_json_field(value: Any, fallback: Any) -> Any:
    if value in (None, ""):
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def storage_root(path: str) -> str:
    if not path:
        return ""
    parts = [part for part in path.split("/") if part]
    if not parts:
        return ""
    return f"/{parts[0]}"


def normalize_ratings(ratings: dict[str, Any] | None) -> dict[str, Any]:
    ratings = ratings or {}

    if "value" in ratings and not any(isinstance(value, dict) for value in ratings.values()):
        value = ratings.get("value")
        return {
            "audience": {
                "label": "Audience",
                "value": value,
                "source": "Rating",
            } if value is not None else None,
            "critic": None,
        }

    audience_sources = [
        ("imdb", "IMDb"),
        ("tmdb", "TMDb"),
        ("trakt", "Trakt"),
    ]
    critic_sources = [
        ("rottenTomatoes", "RT"),
        ("metacritic", "Metacritic"),
    ]

    def pick_rating(candidates: list[tuple[str, str]]) -> dict[str, Any] | None:
        for key, label in candidates:
            rating = ratings.get(key) or {}
            value = rating.get("value")
            if value is not None:
                return {
                    "label": label,
                    "value": value,
                    "source": key,
                }
        return None

    return {
        "audience": pick_rating(audience_sources),
        "critic": pick_rating(critic_sources),
    }


def normalize_movie(movie: dict[str, Any]) -> dict[str, Any]:
    movie_file = movie.get("movieFile") or {}
    size_on_disk = movie.get("sizeOnDisk") or movie_file.get("size") or 0
    title_slug = movie.get("titleSlug") or str(movie["id"])
    collection_data = movie.get("collection") or {}
    collection_tmdb_id = collection_data.get("tmdbId") or movie.get("collectionTmdbId") or 0
    collection_title = collection_data.get("title") or movie.get("collectionTitle") or ""
    return {
        "id": movie["id"],
        "key": f"radarr:{movie['id']}",
        "source": "radarr",
        "type": "movie",
        "title": movie.get("title") or "Untitled",
        "added": movie.get("added") or "",
        "year": movie.get("year"),
        "overview": movie.get("overview") or "",
        "genres": parse_json_field(movie.get("genres"), []),
        "path": movie.get("path") or "",
        "rootFolder": movie.get("rootFolderPath") or "",
        "storageRoot": storage_root(movie.get("rootFolderPath") or movie.get("path") or ""),
        "diskSize": size_on_disk,
        "poster": poster_path({"images": parse_json_field(movie.get("images"), [])}, "radarr"),
        "ratings": normalize_ratings(parse_json_field(movie.get("ratings"), {})),
        "collection": {
            "tmdbId": collection_tmdb_id,
            "title": collection_title,
        } if collection_tmdb_id else None,
        "hasFiles": bool(movie_file.get("id") or size_on_disk),
        "itemPath": f"/movie/{quote(title_slug)}",
        "itemPort": 7878,
    }


def normalize_series(series: dict[str, Any]) -> dict[str, Any]:
    statistics = series.get("statistics") or {}
    title_slug = series.get("titleSlug") or str(series["id"])
    return {
        "id": series["id"],
        "key": f"sonarr:{series['id']}",
        "source": "sonarr",
        "type": "series",
        "title": series.get("title") or "Untitled",
        "added": series.get("added") or "",
        "year": series.get("year"),
        "overview": series.get("overview") or "",
        "genres": parse_json_field(series.get("genres"), []),
        "path": series.get("path") or "",
        "rootFolder": series.get("rootFolderPath") or "",
        "storageRoot": storage_root(series.get("rootFolderPath") or series.get("path") or ""),
        "diskSize": statistics.get("sizeOnDisk") or 0,
        "poster": poster_path({"images": parse_json_field(series.get("images"), [])}, "sonarr"),
        "ratings": normalize_ratings(parse_json_field(series.get("ratings"), {})),
        "hasFiles": (statistics.get("episodeFileCount") or 0) > 0,
        "itemPath": f"/series/{quote(title_slug)}",
        "itemPort": 8989,
    }


def fetch_radarr_items_from_db() -> list[dict[str, Any]]:
    connection = sqlite3.connect(DATABASES["radarr"])
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT
              m.Id,
              m.Path,
              m.MovieFileId,
              m.Added,
              md.Title,
              md.Year,
              md.Overview,
              md.Genres,
              md.Images,
              md.Ratings,
              md.TmdbId,
              md.CollectionTmdbId,
              md.CollectionTitle,
              COALESCE(mf.Size, 0) AS DiskSize
            FROM Movies m
            JOIN MovieMetadata md ON md.Id = m.MovieMetadataId
            LEFT JOIN MovieFiles mf ON mf.Id = m.MovieFileId
            """
        ).fetchall()
        items = []
        for row in rows:
            source = dict(row)
            record = {
                "id": source["Id"],
                "path": source["Path"] or "",
                "added": source["Added"] or "",
                "title": source["Title"] or "Untitled",
                "year": source["Year"],
                "overview": source["Overview"] or "",
                "genres": source["Genres"],
                "images": source["Images"],
                "ratings": source["Ratings"],
                "collectionTmdbId": source.get("CollectionTmdbId") or 0,
                "collectionTitle": source.get("CollectionTitle") or "",
                "rootFolderPath": str(Path(source["Path"]).parent) if source.get("Path") else "",
                "movieFile": {"id": source.get("MovieFileId")} if source.get("MovieFileId") else {},
                "sizeOnDisk": source.get("DiskSize") or 0,
                "titleSlug": str(source.get("TmdbId") or source["Id"]),
            }
            items.append(normalize_movie(record))
        return items
    finally:
        connection.close()


def fetch_sonarr_items_from_db() -> list[dict[str, Any]]:
    connection = sqlite3.connect(DATABASES["sonarr"])
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT
              s.Id,
              s.Title,
              s.TitleSlug,
              s.Added,
              s.Year,
              s.Overview,
              s.Genres,
              s.Images,
              s.Ratings,
              s.Path,
              (
                SELECT COALESCE(SUM(ef.Size), 0)
                FROM Episodes e
                JOIN EpisodeFiles ef ON ef.Id = e.EpisodeFileId
                WHERE e.SeriesId = s.Id AND e.EpisodeFileId > 0
              ) AS DiskSize,
              (
                SELECT COUNT(*)
                FROM Episodes e
                WHERE e.SeriesId = s.Id AND e.EpisodeFileId > 0
              ) AS EpisodeFileCount
            FROM Series s
            """
        ).fetchall()
        items = []
        for row in rows:
            source = dict(row)
            record = {
                "id": source["Id"],
                "title": source["Title"] or "Untitled",
                "added": source["Added"] or "",
                "titleSlug": str(source.get("TitleSlug") or source["Id"]),
                "year": source["Year"],
                "overview": source["Overview"] or "",
                "genres": source["Genres"],
                "images": source["Images"],
                "ratings": source["Ratings"],
                "path": source["Path"] or "",
                "rootFolderPath": str(Path(source["Path"]).parent) if source.get("Path") else "",
                "statistics": {
                    "sizeOnDisk": source.get("DiskSize") or 0,
                    "episodeFileCount": source.get("EpisodeFileCount") or 0,
                },
            }
            items.append(normalize_series(record))
        return items
    finally:
        connection.close()


def fetch_root_folders() -> list[str]:
    folders: set[str] = set()
    for source in SERVICES:
        try:
            entries = api_json(source, "GET", "/api/v3/rootfolder")
        except Exception:
            continue
        for entry in entries:
            path = entry.get("path")
            if path:
                folders.add(path)
    return sorted(folders, key=str.casefold)


def fetch_items() -> dict[str, Any]:
    items: list[dict[str, Any]] = []

    try:
        items.extend(fetch_radarr_items_from_db())
    except Exception as exc:
        print(f"Failed to load Radarr items from DB: {exc}", file=sys.stderr)
        try:
            movies = api_json("radarr", "GET", "/api/v3/movie", query={"includeMovieFile": "true"})
            items.extend(normalize_movie(movie) for movie in movies)
        except Exception as api_exc:
            print(f"Failed to load Radarr items from API: {api_exc}", file=sys.stderr)

    try:
        items.extend(fetch_sonarr_items_from_db())
    except Exception as exc:
        print(f"Failed to load Sonarr items from DB: {exc}", file=sys.stderr)
        try:
            series_list = api_json("sonarr", "GET", "/api/v3/series")
            items.extend(normalize_series(series) for series in series_list)
        except Exception as api_exc:
            print(f"Failed to load Sonarr items from API: {api_exc}", file=sys.stderr)

    genres = sorted({genre for item in items for genre in item["genres"]}, key=str.casefold)
    storage_roots = sorted({item["storageRoot"] for item in items if item.get("storageRoot")}, key=str.casefold)
    return {
        "items": items,
        "rootFolders": fetch_root_folders(),
        "storageRoots": storage_roots,
        "genres": genres,
    }


def actor_image(images: Any) -> str | None:
    parsed_images = images
    if isinstance(images, str):
        try:
            parsed_images = json.loads(images)
        except json.JSONDecodeError:
            return None

    for image in parsed_images or []:
        remote_url = image.get("remoteUrl")
        if remote_url:
            return remote_url
    return None


def fetch_cast(source: str, item_id: int) -> list[dict[str, Any]]:
    db_path = DATABASES[source]
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row

    try:
        if source == "radarr":
            rows = connection.execute(
                """
                SELECT c.Name, c.Character, c.Images
                FROM Movies m
                JOIN Credits c ON c.MovieMetadataId = m.MovieMetadataId
                WHERE m.Id = ?
                  AND c.Type = 0
                  AND IFNULL(c.Character, '') <> ''
                ORDER BY c."Order" ASC, c.Name ASC
                """,
                (item_id,),
            ).fetchall()
            return [
                {
                    "name": row["Name"],
                    "character": row["Character"] or "",
                    "image": actor_image(row["Images"]),
                }
                for row in rows
            ]

        row = connection.execute("SELECT Actors FROM Series WHERE Id = ?", (item_id,)).fetchone()
        if not row or not row["Actors"]:
            return []

        actors = json.loads(row["Actors"])
        return [
            {
                "name": actor.get("name") or "Unknown",
                "character": actor.get("character") or "",
                "image": actor_image(actor.get("images")),
            }
            for actor in actors
        ]
    finally:
        connection.close()


def delete_files_only(item: dict[str, Any]) -> dict[str, Any]:
    source = item["source"]
    item_id = int(item["id"])

    if source == "radarr":
        movie = api_json("radarr", "GET", f"/api/v3/movie/{item_id}")
        movie_file = movie.get("movieFile")
        if not movie_file:
            return {"key": item["key"], "status": "skipped", "message": "No movie file present"}
        api_json("radarr", "DELETE", f"/api/v3/moviefile/{movie_file['id']}")
        return {"key": item["key"], "status": "deleted", "message": "Movie files deleted"}

    episode_files = api_json("sonarr", "GET", "/api/v3/episodefile", query={"seriesId": item_id})
    if not episode_files:
        return {"key": item["key"], "status": "skipped", "message": "No episode files present"}
    for episode_file in episode_files:
        api_json("sonarr", "DELETE", f"/api/v3/episodefile/{episode_file['id']}")
    return {"key": item["key"], "status": "deleted", "message": f"Deleted {len(episode_files)} episode files"}


def remove_and_delete(item: dict[str, Any]) -> dict[str, Any]:
    source = item["source"]
    item_id = int(item["id"])
    if source == "radarr":
        api_json(
            "radarr",
            "DELETE",
            f"/api/v3/movie/{item_id}",
            query={"deleteFiles": "true", "addImportExclusion": "true"},
        )
        return {"key": item["key"], "status": "deleted", "message": "Movie removed from Radarr, files deleted, and import exclusion added"}

    api_json(
        "sonarr",
        "DELETE",
        f"/api/v3/series/{item_id}",
        query={"deleteFiles": "true", "addImportExclusion": "true"},
    )
    return {"key": item["key"], "status": "deleted", "message": "Series removed from Sonarr, files deleted, and import exclusion added"}


def remove_and_delete_collection(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results = []
    seen: set[str] = set()
    for item in items:
        key = item.get("key")
        if key in seen:
            continue
        seen.add(key)
        results.append(remove_and_delete(item))
    return results


class TrimrrHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def end_json(self, payload: Any, status: int = 200) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/items":
            try:
                self.end_json(fetch_items())
            except Exception as exc:
                self.end_json({"error": str(exc)}, status=500)
            return

        if parsed.path == "/api/cast":
            query = parse_qs(parsed.query)
            source = (query.get("source") or [""])[0]
            item_id = (query.get("id") or [""])[0]
            try:
                if source not in DATABASES:
                    raise ValueError("Invalid source")
                self.end_json({"cast": fetch_cast(source, int(item_id))})
            except Exception as exc:
                self.end_json({"error": str(exc)}, status=500)
            return

        if parsed.path == "/api/healthz":
            self.end_json({"ok": True})
            return

        if parsed.path == "/api/poster":
            self.handle_poster(parsed.query)
            return

        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        if parsed.path == "/api/poster":
            self.handle_poster(parsed.query, headers_only=True)
            return

        if parsed.path == "/":
            self.path = "/index.html"
        super().do_HEAD()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/delete":
            self.end_json({"error": "Not found"}, status=404)
            return

        try:
            body = self.read_json_body()
            action = body.get("action")
            items = body.get("items") or []
            if action not in {"delete_files_only", "remove_and_delete", "remove_and_delete_collection"}:
                raise ValueError("Invalid action")

            if action == "remove_and_delete_collection":
                results = remove_and_delete_collection(items)
            else:
                results = []
                for item in items:
                    if action == "delete_files_only":
                        results.append(delete_files_only(item))
                    else:
                        results.append(remove_and_delete(item))

            self.end_json({"ok": True, "results": results})
        except Exception as exc:
            self.end_json({"error": str(exc)}, status=500)

    def translate_path(self, path: str) -> str:
        path = urlparse(path).path
        path = posixpath.normpath(path)
        words = [word for word in path.split("/") if word]
        out_path = STATIC_DIR
        for word in words:
            out_path = out_path / word
        return str(out_path)

    def handle_poster(self, query_string: str, headers_only: bool = False) -> None:
        query = parse_qs(query_string)
        source = (query.get("source") or [""])[0]
        media_path = (query.get("path") or [""])[0]
        if source not in SERVICES or not media_path.startswith("/MediaCover/"):
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid poster request")
            return

        try:
            status, payload, headers = api_request(source, "GET", media_path, accept="image/*")
            if status >= 400:
                self.send_error(status, "Poster unavailable")
                return
            self.send_response(200)
            self.send_header("Content-Type", headers.get("Content-Type", "image/jpeg"))
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            if not headers_only:
                self.wfile.write(payload)
        except Exception as exc:
            self.send_error(HTTPStatus.BAD_GATEWAY, str(exc))

    def read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_length) if content_length else b"{}"
        return json.loads(raw.decode("utf-8"))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), TrimrrHandler)
    print(f"trimrr listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
