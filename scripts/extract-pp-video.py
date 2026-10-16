#!/usr/bin/env python3
"""
Extract/download videos from all links on a page.

Output layout:
	data/pp-videos/<year>/<question-id>.mp4

The script uses yt-dlp for the actual media extraction, because pages whose
videos are visible to Firefox Video DownloadHelper are commonly HLS/DASH or
JavaScript-backed streams. If yt-dlp's generic extractor is not enough, use
--browser-probe to load each link with Playwright and pass discovered media
URLs back to yt-dlp.

Examples:
	python3 scripts/extract-pp-video.py 'https://example.com/past-paper.html'
	python3 scripts/extract-pp-video.py page.html --dry-run
	python3 scripts/extract-pp-video.py page.html --cookies-from-browser firefox
	python3 scripts/extract-pp-video.py page.html --browser-probe --force
	python3 scripts/extract-pp-video.py 'https://winter-s-site-46b8.thinkific.com/courses/take/new-course/lessons/74018107-2012-pib-q8' --cookies-from-browser firefox
"""

from __future__ import annotations

import argparse
import configparser
import hashlib
import html
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import tempfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = PROJECT_ROOT / "data" / "pp-videos"
DEFAULT_BROWSER_PROFILE_ROOT = PROJECT_ROOT / ".playwright-profiles"
DEFAULT_STABLE_FIREFOX = Path("/Applications/Firefox.app/Contents/MacOS/firefox")
DEFAULT_USER_AGENT = (
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
	"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
)

MEDIA_URL_RE = re.compile(
	r"\.(?:mp4|m4v|webm|mov|m3u8|mpd)(?:[?#].*)?$|"
	r"(?:/hls/|/dash/|/manifest|playlist\.m3u8|player\.vimeo\.com|fast\.wistia\.|embedwistia|jwplayer)",
	re.IGNORECASE,
)
YEAR_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
QUESTION_RE = re.compile(
	r"(?i)(?:^|[\s_./?#&=-])(?:question|ques|quest|q|題)\s*[-_:：#]??\s*"
	r"(\d{1,3}(?:\.\d+)?[a-z]?)\b"
)
LESSON_URL_RE = re.compile(r"/courses/take/[^/]+/lessons/", re.IGNORECASE)
JUNK_LINK_TEXT_RE = re.compile(
	r"^(?:|home|log in|login|sign in|sign up|dashboard|courses|back|next|previous|prev|"
	r"facebook|instagram|youtube|twitter|x|linkedin|privacy policy|terms)$",
	re.IGNORECASE,
)


@dataclass(frozen=True)
class LinkItem:
	url: str
	text: str
	index: int


class LinkExtractor(HTMLParser):
	def __init__(self, base_url: str) -> None:
		super().__init__(convert_charrefs=True)
		self.base_url = base_url
		self.links: list[LinkItem] = []
		self._current_href: str | None = None
		self._current_text: list[str] = []

	def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		if tag.lower() != "a":
			return
		attr = dict(attrs)
		href = attr.get("href")
		if href:
			self._current_href = urljoin(self.base_url, html.unescape(href.strip()))
			self._current_text = []

	def handle_data(self, data: str) -> None:
		if self._current_href:
			self._current_text.append(data)

	def handle_endtag(self, tag: str) -> None:
		if tag.lower() != "a" or not self._current_href:
			return
		text = normalize_space(" ".join(self._current_text))
		self.links.append(LinkItem(self._current_href, text, len(self.links) + 1))
		self._current_href = None
		self._current_text = []


def normalize_space(value: str) -> str:
	return re.sub(r"\s+", " ", value or "").strip()


def read_page(source: str, user_agent: str) -> tuple[str, str]:
	"""Return (html_text, base_url) for an HTTP(S) URL or local file."""
	parsed = urlparse(source)
	if parsed.scheme in {"http", "https"}:
		req = Request(source, headers={"User-Agent": user_agent})
		with urlopen(req, timeout=30) as response:
			raw = response.read()
			content_type = response.headers.get("content-type", "")
		charset_match = re.search(r"charset=([^;]+)", content_type, re.IGNORECASE)
		charset = charset_match.group(1).strip() if charset_match else "utf-8"
		return raw.decode(charset, errors="replace"), source

	path = Path(source).expanduser().resolve()
	return path.read_text(encoding="utf-8", errors="replace"), path.as_uri()


def extract_links(source: str, user_agent: str) -> list[LinkItem]:
	html_text, base_url = read_page(source, user_agent)
	parser = LinkExtractor(base_url)
	parser.feed(html_text)
	return dedupe_links(parser.links)


def dedupe_links(links: Iterable[LinkItem]) -> list[LinkItem]:
	seen: set[str] = set()
	result: list[LinkItem] = []
	for link in links:
		parsed = urlparse(link.url)
		if parsed.scheme not in {"http", "https", "file"}:
			continue
		key = link.url.split("#", 1)[0]
		if key in seen:
			continue
		seen.add(key)
		result.append(LinkItem(link.url, link.text, len(result) + 1))
	return result


def same_origin_filter(links: Iterable[LinkItem], source: str, all_domains: bool) -> list[LinkItem]:
	if all_domains:
		return list(links)
	source_parsed = urlparse(source)
	if source_parsed.scheme not in {"http", "https"}:
		return list(links)
	return [link for link in links if urlparse(link.url).netloc == source_parsed.netloc]


def filter_links(
	links: Iterable[LinkItem],
	include_regex: str | None,
	reject_regex: str | None,
	source: str | None = None,
) -> list[LinkItem]:
	include_re = re.compile(include_regex, re.IGNORECASE) if include_regex else None
	reject_re = re.compile(reject_regex, re.IGNORECASE) if reject_regex else None
	source_parsed = urlparse(source or "")
	result = []
	for link in links:
		combined = f"{link.text} {link.url}"
		link_parsed = urlparse(link.url)
		if source_parsed.scheme in {"http", "https"} and link_parsed.scheme in {"http", "https"}:
			# Ignore root/navigation links on course sites. These caused Thinkific
			# lesson URLs to be replaced by https://site/ and then rejected by yt-dlp.
			if link_parsed.netloc == source_parsed.netloc and link_parsed.path in {"", "/"}:
				continue
		if JUNK_LINK_TEXT_RE.fullmatch(normalize_space(link.text)):
			continue
		if include_re and not include_re.search(combined):
			continue
		if reject_re and reject_re.search(combined):
			continue
		result.append(link)
	return result


def is_lesson_url(url: str) -> bool:
	return bool(LESSON_URL_RE.search(urlparse(url).path))


def is_thinkific_url(url: str) -> bool:
	return "thinkific.com" in urlparse(url).netloc.lower()


def default_browser_profile_for_url(url: str) -> Path | None:
	parsed = urlparse(url)
	if "thinkific.com" not in parsed.netloc.lower():
		return None
	return DEFAULT_BROWSER_PROFILE_ROOT / safe_part(parsed.netloc, "thinkific")


def safe_part(value: str, fallback: str) -> str:
	value = unquote(value or "")
	value = normalize_space(value).lower()
	value = re.sub(r"[^a-z0-9._-]+", "-", value)
	value = re.sub(r"-{2,}", "-", value).strip("-._")
	return value or fallback


def derive_year(link: LinkItem, default_year: str) -> str:
	combined = f"{link.text} {link.url}"
	match = YEAR_RE.search(combined)
	return match.group(1) if match else default_year


def derive_question_id(link: LinkItem) -> str:
	parsed = urlparse(link.url)
	query = parse_qs(parsed.query)
	for key in ("question-id", "question_id", "questionId", "qid", "question", "ques", "q", "id"):
		if query.get(key) and query[key][0].strip():
			return safe_part(query[key][0], f"link-{link.index:03d}")

	combined = f"{link.text} {parsed.path}"
	match = QUESTION_RE.search(combined)
	if match:
		return safe_part(f"q{match.group(1)}", f"link-{link.index:03d}")

	stem = Path(unquote(parsed.path.rstrip("/")).split("/")[-1]).stem
	stem = re.sub(r"(?i)\b(?:19|20)\d{2}\b", "", stem)
	stem = re.sub(r"(?i)\b(?:video|solution|answer|answers|paper|pp|dse)\b", "", stem)
	stem = safe_part(stem, "")
	if stem:
		return stem

	text = safe_part(link.text, "")
	if text:
		return text[:80].strip("-._")

	digest = hashlib.sha1(link.url.encode("utf-8")).hexdigest()[:8]
	return f"link-{link.index:03d}-{digest}"


def unique_destination(dest: Path, force: bool) -> Path:
	if force or not dest.exists():
		return dest
	stem = dest.stem
	suffix = dest.suffix
	for i in range(2, 1000):
		candidate = dest.with_name(f"{stem}-{i}{suffix}")
		if not candidate.exists():
			return candidate
	raise RuntimeError(f"too many duplicate output names for {dest}")


def build_ytdlp_command(
	ytdlp: str,
	target_url: str,
	output_mp4: Path,
	user_agent: str,
	referer: str | None,
	cookies_from_browser: str | None,
	force: bool,
	extra_args: list[str],
) -> list[str]:
	output_template = str(output_mp4.with_suffix(".%(ext)s"))
	cmd = [
		ytdlp,
		"--no-playlist",
		"--merge-output-format",
		"mp4",
		"--remux-video",
		"mp4",
		"--user-agent",
		user_agent,
		"-o",
		output_template,
	]
	if force:
		cmd.append("--force-overwrites")
	else:
		cmd.append("--no-overwrites")
	if referer:
		cmd.extend(["--referer", referer])
	if cookies_from_browser:
		cmd.extend(["--cookies-from-browser", cookies_from_browser])
	cmd.extend(extra_args)
	cmd.append(target_url)
	return cmd


def run_ytdlp(cmd: list[str], dry_run: bool) -> bool:
	print("  $ " + " ".join(shell_quote(part) for part in cmd))
	if dry_run:
		return True
	completed = subprocess.run(cmd, text=True)
	return completed.returncode == 0


def shell_quote(value: str) -> str:
	if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", value):
		return value
	return "'" + value.replace("'", "'\\''") + "'"


def find_firefox_cookie_dbs() -> list[Path]:
	profiles_root = Path.home() / "Library" / "Application Support" / "Firefox" / "Profiles"
	if not profiles_root.exists():
		return []
	return sorted(profiles_root.glob("*/cookies.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)


def find_firefox_profile_dirs() -> list[Path]:
	firefox_root = Path.home() / "Library" / "Application Support" / "Firefox"
	profiles_root = firefox_root / "Profiles"
	if not profiles_root.exists():
		return []

	profiles: list[Path] = []
	profiles_ini = firefox_root / "profiles.ini"
	if profiles_ini.exists():
		config = configparser.ConfigParser()
		config.read(profiles_ini)
		for section in config.sections():
			if not section.lower().startswith("profile"):
				continue
			profile_path = config.get(section, "Path", fallback="").strip()
			if not profile_path:
				continue
			is_relative = config.get(section, "IsRelative", fallback="1").strip() != "0"
			path = (firefox_root / profile_path) if is_relative else Path(profile_path)
			if path.exists() and path not in profiles:
				profiles.append(path)

	for path in sorted(profiles_root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
		if path.is_dir() and (path / "prefs.js").exists() and path not in profiles:
			profiles.append(path)
	return profiles


def firefox_profile_cookie_score(profile_dir: Path, url: str) -> int:
	host = urlparse(url).hostname or ""
	cookie_db = profile_dir / "cookies.sqlite"
	if not host or not cookie_db.exists():
		return 0
	try:
		with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
			shutil.copy2(cookie_db, tmp.name)
			conn = sqlite3.connect(tmp.name)
			try:
				row = conn.execute(
					"""
					SELECT COUNT(*)
					FROM moz_cookies
					WHERE ? = host OR ? LIKE '%' || ltrim(host, '.')
					""",
					(host, host),
				).fetchone()
			finally:
				conn.close()
		return int(row[0] if row else 0)
	except Exception:
		return 0


def firefox_profile_cookie_names(profile_dir: Path, url: str) -> list[str]:
	host = urlparse(url).hostname or ""
	cookie_db = profile_dir / "cookies.sqlite"
	if not host or not cookie_db.exists():
		return []
	try:
		with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
			shutil.copy2(cookie_db, tmp.name)
			conn = sqlite3.connect(tmp.name)
			try:
				rows = conn.execute(
					"""
					SELECT DISTINCT name
					FROM moz_cookies
					WHERE ? = host OR ? LIKE '%' || ltrim(host, '.')
					ORDER BY name
					""",
					(host, host),
				).fetchall()
			finally:
				conn.close()
		return [str(row[0]) for row in rows]
	except Exception:
		return []


def looks_like_thinkific_login(profile_dir: Path, url: str) -> bool:
	names = firefox_profile_cookie_names(profile_dir, url)
	ignored = {
		"__cf_bm",
		"cf_clearance",
		"__stripe_mid",
		"__stripe_sid",
		"__thinkific_store_email__",
		"__thinkific_store_subdomain__",
	}
	auth_re = re.compile(r"(?i)(session|remember|auth|token|jwt|user|member|learner|identity|signed)")
	return any(name not in ignored and auth_re.search(name) for name in names)


def find_best_firefox_profile_for_url(url: str) -> Path | None:
	profiles = [
		profile
		for profile in find_firefox_profile_dirs()
		if profile.resolve() != DEFAULT_BROWSER_PROFILE_ROOT.resolve()
		and DEFAULT_BROWSER_PROFILE_ROOT.resolve() not in profile.resolve().parents
	]
	if not profiles:
		return None
	profiles = sorted(
		profiles,
		key=lambda p: (firefox_profile_cookie_score(p, url), p.stat().st_mtime),
		reverse=True,
	)
	return profiles[0]


def find_best_firefox_profile_for_url_excluding(url: str, excluded: Path) -> Path | None:
	excluded_resolved = excluded.resolve()
	profiles = [
		profile
		for profile in find_firefox_profile_dirs()
		if profile.resolve() != excluded_resolved
		and excluded_resolved not in profile.resolve().parents
		and profile.resolve() != DEFAULT_BROWSER_PROFILE_ROOT.resolve()
		and DEFAULT_BROWSER_PROFILE_ROOT.resolve() not in profile.resolve().parents
	]
	if not profiles:
		return None
	profiles = sorted(
		profiles,
		key=lambda p: (firefox_profile_cookie_score(p, url), p.stat().st_mtime),
		reverse=True,
	)
	return profiles[0]


def clone_firefox_profile(source: Path, destination: Path, force: bool = False) -> bool:
	if not source.exists():
		return False
	if destination.exists() and not force and any(destination.iterdir()):
		return False
	if destination.exists() and force:
		shutil.rmtree(destination)
	destination.mkdir(parents=True, exist_ok=True)

	ignored_names = {
		"parent.lock",
		"lock",
		".parentlock",
		"compatibility.ini",
		"times.json",
		"Telemetry.ShutdownTime.txt",
	}
	ignored_dirs = {
		"cache2",
		"startupCache",
		"shader-cache",
		"crashes",
		"minidumps",
		"datareporting",
		"saved-telemetry-pings",
		"thumbnails",
	}

	def ignore(_dir: str, names: list[str]) -> set[str]:
		return {name for name in names if name in ignored_names or name in ignored_dirs or name.endswith(".tmp")}

	shutil.copytree(source, destination, dirs_exist_ok=True, ignore=ignore)
	prepare_firefox_profile_for_playwright(destination)
	return True


def prepare_firefox_profile_for_playwright(profile_dir: Path) -> None:
	"""Allow Playwright's bundled Firefox to open a cloned profile from stable Firefox."""
	profile_dir.mkdir(parents=True, exist_ok=True)
	compatibility = profile_dir / "compatibility.ini"
	if compatibility.exists():
		try:
			compatibility.unlink()
		except OSError:
			pass
	user_js = profile_dir / "user.js"
	line = 'user_pref("browser.startup.homepage_override.mstone", "ignore");\n'
	try:
		existing = user_js.read_text(encoding="utf-8", errors="replace") if user_js.exists() else ""
		if line not in existing:
			with user_js.open("a", encoding="utf-8") as handle:
				if existing and not existing.endswith("\n"):
					handle.write("\n")
				handle.write(line)
	except OSError:
		pass


def load_firefox_cookies_for_url(url: str) -> list[dict]:
	"""Read Firefox cookies.sqlite files and return Playwright-compatible cookies."""
	host = urlparse(url).hostname or ""
	if not host:
		return []
	results: list[dict] = []
	seen: set[tuple[str, str, str]] = set()
	for cookie_db in find_firefox_cookie_dbs():
		try:
			with tempfile.NamedTemporaryFile(suffix=".sqlite") as tmp:
				shutil.copy2(cookie_db, tmp.name)
				conn = sqlite3.connect(tmp.name)
				try:
					rows = conn.execute(
						"""
						SELECT host, path, name, value, expiry, isSecure, isHttpOnly, sameSite
						FROM moz_cookies
						WHERE ? = host OR ? LIKE '%' || ltrim(host, '.')
						""",
						(host, host),
					).fetchall()
				finally:
					conn.close()
		except Exception:
			continue

		for cookie_host, path, name, value, expiry, is_secure, is_http_only, same_site in rows:
			key = (cookie_host, path, name)
			if key in seen:
				continue
			seen.add(key)
			expires = int(expiry or -1)
			if expires <= 0:
				expires = -1
			elif expires > 99_999_999_999:
				expires = expires // 1000
			cookie = {
				"name": name,
				"value": value,
				"domain": cookie_host,
				"path": path or "/",
				"expires": expires,
				"httpOnly": bool(is_http_only),
				"secure": bool(is_secure),
			}
			if same_site == 1:
				cookie["sameSite"] = "Lax"
			elif same_site == 2:
				cookie["sameSite"] = "Strict"
			elif same_site == 3:
				cookie["sameSite"] = "None"
			results.append(cookie)
	return results


def probe_media_urls_with_playwright(
	link_url: str,
	wait_seconds: float,
	cookies_from_browser: str | None,
	browser_profile: Path | None,
	firefox_executable: Path | None,
	login: bool,
	show_browser: bool,
) -> list[str]:
	try:
		from playwright.sync_api import sync_playwright
	except ImportError as exc:
		raise RuntimeError(
			"Playwright is not installed. Install it with: "
			"python3 -m pip install playwright && python3 -m playwright install firefox"
		) from exc

	found: list[str] = []
	seen: set[str] = set()

	def remember(url: str) -> None:
		if url and url not in seen and MEDIA_URL_RE.search(url):
			seen.add(url)
			found.append(url)

	with sync_playwright() as p:
		browser = None
		launch_kwargs = {"headless": not (login or show_browser)}
		if firefox_executable:
			launch_kwargs["executable_path"] = str(firefox_executable)
			print(f"  using Firefox executable: {firefox_executable}")
		if browser_profile:
			browser_profile.mkdir(parents=True, exist_ok=True)
			context = p.firefox.launch_persistent_context(
				str(browser_profile),
				user_agent=DEFAULT_USER_AGENT,
				**launch_kwargs,
			)
			print(f"  using browser profile: {browser_profile}")
		else:
			browser = p.firefox.launch(**launch_kwargs)
			context = browser.new_context(user_agent=DEFAULT_USER_AGENT)
		if cookies_from_browser and cookies_from_browser.split(":", 1)[0].lower() == "firefox":
			cookies = load_firefox_cookies_for_url(link_url)
			if cookies:
				context.add_cookies(cookies)
				print(f"  loaded {len(cookies)} Firefox cookie(s) for browser probe")
			else:
				print("  warning: no matching Firefox cookies found for browser probe")
		page = context.pages[0] if context.pages else context.new_page()

		page.on("request", lambda request: remember(request.url))
		page.on("response", lambda response: remember(response.url))
		page.goto(link_url, wait_until="domcontentloaded", timeout=45_000)
		try:
			page.wait_for_load_state("networkidle", timeout=15_000)
		except Exception:
			pass
		if "/users/sign_in" in page.url or "/users/sign_up" in page.url:
			print(f"  warning: browser probe was redirected to {page.url}; Firefox is probably not logged in to Thinkific")
			if login:
				print("  log in in the opened browser window, then return here and press Enter.")
				input("  Press Enter after login is complete... ")
				page.goto(link_url, wait_until="domcontentloaded", timeout=45_000)
				try:
					page.wait_for_load_state("networkidle", timeout=15_000)
				except Exception:
					pass
				if "/users/sign_in" in page.url or "/users/sign_up" in page.url:
					print(f"  still redirected to {page.url}; login was not completed")

		for selector in (
			"button[aria-label*='play' i]",
			"button[title*='play' i]",
			".play-button",
			".plyr__control[data-plyr='play']",
			"[data-testid*='play' i]",
			"video",
			"iframe",
		):
			try:
				locator = page.locator(selector).first
				if locator.count() > 0:
					locator.click(timeout=2_000, trial=False)
			except Exception:
				pass
		if wait_seconds > 0:
			time.sleep(wait_seconds)

		media_from_dom = page.evaluate(
			"""
			() => Array.from(document.querySelectorAll('video, source, a, iframe, embed')).flatMap((el) => {
			  const urls = [];
			  for (const attr of ['src', 'href', 'data-src']) {
				const value = el.getAttribute(attr);
				if (value) urls.push(new URL(value, location.href).href);
			  }
			  if (el.currentSrc) urls.push(new URL(el.currentSrc, location.href).href);
			  if (el.src) urls.push(new URL(el.src, location.href).href);
			  return urls;
			})
			"""
		)
		for url in media_from_dom:
			remember(url)

		for frame in page.frames:
			remember(frame.url)
			try:
				frame_urls = frame.evaluate(
					"""
					() => Array.from(document.querySelectorAll('video, source, a, iframe, embed')).flatMap((el) => {
					  const urls = [];
					  for (const attr of ['src', 'href', 'data-src']) {
						const value = el.getAttribute(attr);
						if (value) urls.push(new URL(value, location.href).href);
					  }
					  if (el.currentSrc) urls.push(new URL(el.currentSrc, location.href).href);
					  if (el.src) urls.push(new URL(el.src, location.href).href);
					  return urls;
					})
					"""
				)
			except Exception:
				frame_urls = []
			for url in frame_urls:
				remember(url)
		context.close()
		if browser:
			browser.close()

	return found


def parse_extra_ytdlp_args(values: list[str]) -> list[str]:
	if not values:
		return []
	joined = " ".join(values).strip()
	if not joined:
		return []
	# Keep parsing simple and safe enough for regular option strings.
	import shlex

	return shlex.split(joined)


def ensure_playwright_available_if_needed(enabled: bool) -> None:
	if not enabled:
		return
	try:
		import playwright  # noqa: F401
		return
	except ImportError:
		pass

	venv_python = PROJECT_ROOT / ".venv" / "bin" / "python"
	if venv_python.exists() and Path(sys.prefix).resolve() != (PROJECT_ROOT / ".venv").resolve():
		print(f"Playwright is not installed for {sys.executable}; re-running with {venv_python}")
		os.execv(str(venv_python), [str(venv_python), str(Path(__file__).resolve()), *sys.argv[1:]])

	raise RuntimeError(
		"Playwright is required for Thinkific/browser probing. Install it with: "
		"python3 -m venv .venv && .venv/bin/python -m pip install playwright && "
		".venv/bin/python -m playwright install firefox"
	)


def run_native_firefox_login(firefox_executable: Path, profile_dir: Path, url: str) -> bool:
	profile_dir.mkdir(parents=True, exist_ok=True)
	while True:
		print(f"Opening stable Firefox for login: {firefox_executable}")
		print(f"Using profile: {profile_dir}")
		print("Complete the login in Firefox, confirm the lesson page opens, then close that Firefox window.")
		process = subprocess.Popen([
			str(firefox_executable),
			"-no-remote",
			"-profile",
			str(profile_dir),
			url,
		], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
		while process.poll() is None:
			input("Press Enter after the Firefox window is closed... ")
			if process.poll() is None:
				print("Firefox still appears to be running. Please close the login Firefox window first so cookies are saved.")
		process.wait(timeout=5)
		prepare_firefox_profile_for_playwright(profile_dir)

		if not is_thinkific_url(url) or looks_like_thinkific_login(profile_dir, url):
			return True

		cookie_names = ", ".join(firefox_profile_cookie_names(profile_dir, url)) or "none"
		print("warning: no obvious Thinkific login/session cookie was saved in the native Firefox profile.")
		print(f"  cookies for this host: {cookie_names}")
		print("  Make sure the opened Firefox reaches the actual lesson page after Google login, not just the sign-in page.")
		answer = input("Press Enter to try native Firefox login again, or type 'skip' to continue anyway: ").strip().lower()
		if answer in {"s", "skip", "q", "quit"}:
			return False


def main() -> int:
	parser = argparse.ArgumentParser(
		description="Download videos found through links on a page into data/pp-videos/<year>/<question-id>.mp4."
	)
	parser.add_argument("page", help="Source page URL or local HTML file containing question/video links.")
	parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT, help=f"Default: {DEFAULT_OUTPUT_ROOT}")
	parser.add_argument("--default-year", default="unknown", help="Year folder when no year is found in link text/URL.")
	parser.add_argument("--include-regex", help="Only process links whose text or URL matches this regex.")
	parser.add_argument("--reject-regex", help="Skip links whose text or URL matches this regex.")
	parser.add_argument("--all-domains", action="store_true", help="Process off-site links too. Default is same-origin only for URL pages.")
	parser.add_argument("--include-page", action="store_true", help="Also try to extract a video from the source page itself.")
	parser.add_argument("--links-only", action="store_true", help="Only process links found on the page; do not auto-process direct lesson pages.")
	parser.add_argument("--browser-probe", action="store_true", help="Use Playwright/Firefox to capture media URLs from each linked page before yt-dlp.")
	parser.add_argument("--browser-wait", type=float, default=2.0, help="Extra seconds to wait during --browser-probe. Default: 2")
	parser.add_argument("--browser-profile", type=Path, help="Persistent Playwright browser profile directory. Thinkific uses this automatically.")
	parser.add_argument("--firefox-profile", type=Path, help="Clone this existing Firefox profile into the Playwright profile before probing.")
	parser.add_argument("--no-clone-firefox-profile", action="store_true", help="Do not clone the existing logged-in Firefox profile into the Playwright profile.")
	parser.add_argument("--refresh-firefox-profile", action="store_true", help="Re-clone the existing Firefox profile even if the Playwright profile already exists.")
	parser.add_argument("--firefox-executable", type=Path, help="Use a specific Firefox binary instead of Playwright's bundled Firefox.")
	parser.add_argument("--system-firefox", action="store_true", help=f"Try stable Firefox at {DEFAULT_STABLE_FIREFOX}. Note: stock Firefox usually cannot be automated by Playwright; the default is the bundled Playwright Firefox with a cloned stable profile.")
	parser.add_argument("--bundled-firefox", action="store_true", help="Use Playwright's bundled Firefox build instead of installed stable Firefox.")
	parser.add_argument("--login", action="store_true", help="Open the browser visibly and wait for manual login before probing videos.")
	parser.add_argument("--playwright-login", action="store_true", help="Do login inside Playwright instead of native stable Firefox. Google may block this.")
	parser.add_argument("--show-browser", action="store_true", help="Show the Playwright browser while probing.")
	parser.add_argument("--cookies-from-browser", help="Pass browser cookies to yt-dlp, e.g. firefox or chrome.")
	parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT)
	parser.add_argument("--ytdlp", default="yt-dlp", help="yt-dlp executable path. Default: yt-dlp")
	parser.add_argument("--force", action="store_true", help="Overwrite existing mp4 files.")
	parser.add_argument("--dry-run", action="store_true", help="Print what would be downloaded without running yt-dlp.")
	parser.add_argument("--yt-dlp-args", nargs=argparse.REMAINDER, default=[], help="Extra args passed to yt-dlp after --, e.g. --yt-dlp-args --verbose")
	args = parser.parse_args()

	ytdlp_path = shutil.which(args.ytdlp) or args.ytdlp
	if not args.dry_run and not shutil.which(ytdlp_path) and not Path(ytdlp_path).exists():
		print("error: yt-dlp was not found. Install with: python3 -m pip install yt-dlp", file=sys.stderr)
		return 2

	auto_direct_page = is_lesson_url(args.page) and not args.links_only
	auto_browser_probe = is_thinkific_url(args.page) and not args.links_only
	ensure_playwright_available_if_needed(args.browser_probe or auto_browser_probe or args.login)

	browser_profile = args.browser_profile or (default_browser_profile_for_url(args.page) if auto_browser_probe else None)
	if browser_profile and not args.no_clone_firefox_profile:
		source_profile = args.firefox_profile or find_best_firefox_profile_for_url(args.page)
		if source_profile and source_profile.resolve() == browser_profile.resolve():
			source_profile = find_best_firefox_profile_for_url_excluding(args.page, browser_profile)
		if source_profile:
			if clone_firefox_profile(source_profile, browser_profile, force=args.refresh_firefox_profile):
				print(f"Cloned Firefox profile: {source_profile} -> {browser_profile}")
			elif browser_profile.exists() and any(browser_profile.iterdir()):
				print(f"Using existing cloned Firefox profile: {browser_profile}")
			else:
				print(f"warning: could not clone Firefox profile: {source_profile}")
		else:
			print("warning: no existing Firefox profile found to clone")
	firefox_executable = args.firefox_executable
	if not firefox_executable and args.system_firefox and not args.bundled_firefox and DEFAULT_STABLE_FIREFOX.exists():
		firefox_executable = DEFAULT_STABLE_FIREFOX
	if firefox_executable and not firefox_executable.exists():
		print(f"error: Firefox executable not found: {firefox_executable}", file=sys.stderr)
		return 2
	if firefox_executable and is_thinkific_url(args.page):
		print("warning: stock/stable Firefox often times out with Playwright automation; omit --system-firefox to use the bundled Playwright Firefox with your cloned stable profile.")
	native_login_done = False
	if args.login and not args.playwright_login and browser_profile and DEFAULT_STABLE_FIREFOX.exists():
		if not run_native_firefox_login(DEFAULT_STABLE_FIREFOX, browser_profile, args.page):
			print("error: native Firefox did not create a Thinkific session, so browser probing would only return the sign-in page.")
			print("Open the lesson in your normal Firefox profile and confirm Thinkific itself can access it, then rerun with --refresh-firefox-profile.")
			return 1
		native_login_done = True

	links = [] if auto_direct_page else extract_links(args.page, args.user_agent)
	links = same_origin_filter(links, args.page, args.all_domains)
	links = filter_links(links, args.include_regex, args.reject_regex, args.page)
	if args.include_page or auto_direct_page:
		links.insert(0, LinkItem(args.page, "source-page", 0))

	if not links:
		print("No matching links found.")
		return 0

	extra_args = parse_extra_ytdlp_args(args.yt_dlp_args)
	if auto_direct_page:
		print("Detected a direct lesson URL; processing the source page instead of navigation links.")
	if auto_browser_probe and not args.browser_probe:
		print("Detected Thinkific; enabling browser probe automatically. Use --links-only to disable this behavior.")
	print(f"Found {len(links)} matching link(s).")

	ok_count = 0
	skip_count = 0
	fail_count = 0
	used_destinations: set[Path] = set()
	for i, link in enumerate(links, start=1):
		year = safe_part(derive_year(link, args.default_year), args.default_year)
		question_id = derive_question_id(link)
		output_dir = args.output_root / year
		output_dir.mkdir(parents=True, exist_ok=True)
		output_mp4 = output_dir / f"{question_id}.mp4"
		if output_mp4 in used_destinations:
			output_mp4 = unique_destination(output_mp4, args.force)
		used_destinations.add(output_mp4)

		print(f"\n[{i}/{len(links)}] {link.text or link.url}")
		print(f"  -> {output_mp4.relative_to(PROJECT_ROOT) if output_mp4.is_relative_to(PROJECT_ROOT) else output_mp4}")
		if output_mp4.exists() and output_mp4.stat().st_size > 0 and not args.force:
			print("  [skip] already exists; use --force to overwrite")
			skip_count += 1
			continue

		targets = [link.url]
		if args.browser_probe or auto_browser_probe:
			try:
				probed = probe_media_urls_with_playwright(
					link.url,
					args.browser_wait,
					args.cookies_from_browser,
					browser_profile,
					firefox_executable,
					args.login and not native_login_done,
					args.show_browser,
				)
				if probed:
					print(f"  browser probe found {len(probed)} media URL(s)")
					targets = probed
				else:
					if is_thinkific_url(link.url):
						print("  browser probe found no media URLs; not falling back to yt-dlp for Thinkific.")
						if args.login:
							cookie_names = ", ".join(firefox_profile_cookie_names(browser_profile, link.url)) if browser_profile else "none"
							print("  Native Firefox login did not produce a usable Thinkific session for this profile.")
							print(f"  cookies for this host: {cookie_names or 'none'}")
							print("  Re-run with --login and do not continue until the opened Firefox shows the actual lesson page.")
						else:
							print("  If this is an auth problem, run again with --login and complete login in the opened browser.")
						targets = []
					else:
						print("  browser probe found no direct media URLs; falling back to linked page")
			except Exception as exc:
				if is_thinkific_url(link.url):
					print(f"  browser probe failed: {exc}")
					print("  not falling back to yt-dlp for Thinkific because it only reaches the sign-in page.")
					targets = []
				else:
					print(f"  browser probe failed: {exc}; falling back to linked page")

		success = False
		for target in targets:
			cmd = build_ytdlp_command(
				ytdlp=ytdlp_path,
				target_url=target,
				output_mp4=output_mp4,
				user_agent=args.user_agent,
				referer=link.url if target != link.url else args.page,
				cookies_from_browser=args.cookies_from_browser,
				force=args.force,
				extra_args=extra_args,
			)
			if run_ytdlp(cmd, args.dry_run):
				success = True
				break

		if success:
			ok_count += 1
		else:
			fail_count += 1

	print(f"\nDone: {ok_count} succeeded, {skip_count} skipped, {fail_count} failed.")
	return 0 if fail_count == 0 else 1


if __name__ == "__main__":
	raise SystemExit(main())
