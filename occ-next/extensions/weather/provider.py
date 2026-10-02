"""天气工具：**一个单例，它的公开方法就是工具**。

宿主在注册时把这个类实例化一次，之后每次调用都是同一个对象。所以：

- `__init__` 里读配置、建东西——**只做一次**
- 公开方法就是工具：名字是工具名（`current` → `weather.current`），
  **参数 schema 从签名读**（声明里不写，写两遍就会漂移）
- `_` 开头的、property、dunder 都不算工具

**包的配置由包自己读**（`config.yaml` 就在旁边）——宿主不参与。

**失败就抛，不吞。** 包内工具抛异常会直接冒到宿主，由 `gateway/function/` 那边
翻译成一次失败的调用结果——那里才知道该回给 Worker 什么形状。在这里返回一个
`{"ok": false}` 只是让模型收到一份长得像数据的错误。
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import yaml

#: WMO 天气代码 → （中文、图标）。Open-Meteo 只给代码，人要看的是这两个。
WMO_DESC: dict[int, tuple[str, str]] = {
    0: ("晴", "☀️"), 1: ("基本晴", "🌤️"), 2: ("多云", "⛅"), 3: ("阴", "☁️"),
    45: ("雾", "🌫️"), 48: ("雾凇", "🌫️"), 51: ("毛毛雨", "🌦️"),
    53: ("毛毛雨", "🌦️"), 55: ("毛毛雨", "🌦️"), 56: ("冻毛毛雨", "🌧️"),
    57: ("冻毛毛雨", "🌧️"), 61: ("小雨", "🌧️"), 63: ("中雨", "🌧️"),
    65: ("大雨", "🌧️"), 66: ("冻雨", "🌧️"), 67: ("冻雨", "🌧️"),
    71: ("小雪", "🌨️"), 73: ("中雪", "🌨️"), 75: ("大雪", "❄️"),
    77: ("雪粒", "🌨️"), 80: ("阵雨", "🌦️"), 81: ("阵雨", "🌧️"),
    82: ("强阵雨", "⛈️"), 85: ("阵雪", "🌨️"), 86: ("强阵雪", "❄️"),
    95: ("雷暴", "⛈️"), 96: ("雷暴伴冰雹", "⛈️"), 99: ("雷暴伴大冰雹", "⛈️"),
}

DEFAULT_ENDPOINT = "https://api.open-meteo.com/v1/forecast"


class Weather:
    """按城市查天气。城市表在 `config.yaml` 里。"""

    def __init__(self) -> None:
        config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text("utf-8")) or {}
        self.endpoint = str(config.get("endpoint") or DEFAULT_ENDPOINT)
        self.timeout = float(config.get("timeout") or 8)
        self.cities: dict[str, tuple[float, float]] = {
            str(city): (float(coords[0]), float(coords[1]))
            for city, coords in (config.get("cities") or {}).items()
        }

    def current(self, city: str = "杭州", latitude: float | None = None,
                longitude: float | None = None, timezone: str = "Asia/Shanghai") -> dict:
        """查一个城市现在的天气。给坐标就按坐标，否则按城市表里的。"""
        if (latitude is None) != (longitude is None):
            raise ValueError("latitude 和 longitude 必须同时提供")
        coords = (float(latitude), float(longitude)) if latitude is not None \
            else self.cities.get(city)
        if coords is None:
            raise ValueError(f"没有这个城市的坐标: {city}（表里有 {sorted(self.cities)}）")
        query = urlencode({
            "latitude": coords[0], "longitude": coords[1],
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,"
                       "weather_code,wind_speed_10m",
            "timezone": timezone,
        })
        request = Request(f"{self.endpoint}?{query}", headers={"Accept": "application/json"})
        with urlopen(request, timeout=self.timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        now = data.get("current")
        if not isinstance(now, dict):
            raise ValueError("天气服务没给 current 那一段")
        code = int(now.get("weather_code") or 0)
        desc, icon = WMO_DESC.get(code, ("未知", "🌡️"))
        return {
            "city": city, "latitude": coords[0], "longitude": coords[1],
            "temp": now.get("temperature_2m"), "feels": now.get("apparent_temperature"),
            "humidity": now.get("relative_humidity_2m"), "wind": now.get("wind_speed_10m"),
            "desc": desc, "icon": icon, "weather_code": code,
            "at": now.get("time"), "timezone": timezone,
        }
