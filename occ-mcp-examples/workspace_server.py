from pathlib import Path

from fastmcp import FastMCP

mcp = FastMCP("occ-workspace")


@mcp.tool()
def list_names(directory: str = ".") -> list[str]:
    """List names in a directory for connection testing."""
    return sorted(item.name for item in Path(directory).iterdir())


if __name__ == "__main__":
    mcp.run(transport="stdio")
