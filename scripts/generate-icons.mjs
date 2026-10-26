import { _electron as electron } from "@playwright/test";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const root = path.resolve("desktop/assets");
const svg = (await readFile(path.join(root, "app.svg"))).toString("base64");
const profile = await mkdtemp(path.join(os.tmpdir(), "aico-icon-render-"));
const app = await electron.launch({
  args: [path.resolve("scripts/render-icons.cjs")],
  env: { ...process.env, AICO_ICON_PROFILE: profile },
});
try {
  const page = await app.firstWindow();
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) {
    const rendered = await page.evaluate(
      async ({ svg, size }) => {
        const img = new Image();
        img.src = "data:image/svg+xml;base64," + svg;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, size, size);
        return {
          png: canvas.toDataURL("image/png").split(",")[1],
          rgba:
            size < 256
              ? Array.from(ctx.getImageData(0, 0, size, size).data)
              : [],
        };
      },
      { svg, size },
    );
    const png = Buffer.from(rendered.png, "base64");
    if (size === 256) images.push(png);
    else {
      // Classic BGRA DIB + AND mask ensures native small-icon extraction works.
      const maskStride = Math.ceil(size / 32) * 4;
      const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
      dib.writeUInt32LE(40, 0);
      dib.writeInt32LE(size, 4);
      dib.writeInt32LE(size * 2, 8);
      dib.writeUInt16LE(1, 12);
      dib.writeUInt16LE(32, 14);
      dib.writeUInt32LE(size * size * 4, 20);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const source = (y * size + x) * 4,
            row = size - 1 - y,
            dest = 40 + (row * size + x) * 4;
          dib[dest] = rendered.rgba[source + 2];
          dib[dest + 1] = rendered.rgba[source + 1];
          dib[dest + 2] = rendered.rgba[source];
          dib[dest + 3] = rendered.rgba[source + 3];
          if (!rendered.rgba[source + 3])
            dib[40 + size * size * 4 + row * maskStride + (x >> 3)] |=
              0x80 >> (x & 7);
        }
      images.push(dib);
    }
    await writeFile(path.join(root, `app-${size}.png`), png);
  }
  // Small sizes use DIB; the 256px representation uses PNG.
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  await writeFile(
    path.join(root, "app.ico"),
    Buffer.concat([header, ...images]),
  );
} finally {
  await app.close();
}
console.log(
  "Generated multi-resolution Windows and tray icons from desktop/assets/app.svg",
);
