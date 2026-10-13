// Local addition: writes an exported bundle into ../exports/ so exports land in the repo
// rather than wherever the browser saves downloads. POST the zip body; ?name= sets the file name.
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export async function POST(req: Request) {
  const name = (new URL(req.url).searchParams.get("name") ?? "export.zip").replace(/[^\w.-]/g, "_");
  const dir = path.join(process.cwd(), "..", "exports");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), Buffer.from(await req.arrayBuffer()));
  return Response.json({ saved: path.join(dir, name) });
}
