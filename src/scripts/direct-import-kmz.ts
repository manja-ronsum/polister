// src/scripts/direct-import-kmz.ts
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { Command } from "commander";
import { PrismaClient } from "@prisma/client";
import { normalizeBoardNumber } from "@/shared/domain/board/BoardNumber";

const prisma = new PrismaClient();

interface ExtractedBoard {
  boardNumber: string | null;
  address: string;
  name: string;
  lat: number;
  lng: number;
}

function cleanXmlText(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseKmlPlacemarks(kmlText: string): ExtractedBoard[] {
  const boards: ExtractedBoard[] = [];
  const placemarkRegex = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;

  let match: RegExpExecArray | null;
  while ((match = placemarkRegex.exec(kmlText)) !== null) {
    const block = match[1];

    const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/i);
    const coordMatch = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);

    if (!coordMatch) continue;

    const rawName = cleanXmlText(nameMatch?.[1] ?? "");
    const rawDesc = cleanXmlText(descMatch?.[1] ?? "");
    const coordText = coordMatch[1].trim().split(/\s+/)[0];
    const [lngStr, latStr] = coordText.split(",");

    const lat = Number.parseFloat(latStr ?? "");
    const lng = Number.parseFloat(lngStr ?? "");

    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    let boardNumber: string | null = rawName || null;
    if (boardNumber) {
      try {
        boardNumber = normalizeBoardNumber(boardNumber);
      } catch {
        // 正規化ルール外の場合はそのまま文字列として保持
      }
    }

    const address = rawDesc || rawName || "住所未設定";
    const displayName = rawDesc ? `${rawDesc} (${rawName})` : rawName;

    boards.push({
      boardNumber,
      address,
      name: displayName,
      lat,
      lng,
    });
  }

  return boards;
}

async function main() {
  const program = new Command();
  program
    .requiredOption("-f, --file <path>", "KMZ または KML ファイルのパス")
    .requiredOption("-p, --prefecture <name>", "都道府県名 (例: 茨城県)")
    .requiredOption("-c, --city <name>", "市区町村名 (例: つくば市)")
    .option("--code <code>", "自治体コード (省略時は 08220 等を自動補完)", "08220")
    .option("--clear", "同じ自治体の既存ピンを一度全削除してから入れ直す", false)
    .parse(process.argv);

  const opts = program.opts<{
    file: string;
    prefecture: string;
    city: string;
    code: string;
    clear: boolean;
  }>();

  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`ファイルが見つかりません: ${filePath}`);
  }

  // 1. KMZ または KML から XML を読み込む
  let kmlText = "";
  if (filePath.toLowerCase().endsWith(".kmz")) {
    const zip = new AdmZip(filePath);
    const kmlEntry = zip
      .getEntries()
      .find((entry) => entry.entryName.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) {
      throw new Error("KMZ内に .kml ファイルが含まれていません。");
    }
    kmlText = kmlEntry.getData().toString("utf8");
  } else {
    kmlText = fs.readFileSync(filePath, "utf8");
  }

  const boards = parseKmlPlacemarks(kmlText);
  console.log(`✅ KMLから ${boards.length} 件の掲示場データを抽出しました。`);

  if (boards.length === 0) {
    console.log("⚠️ 登録対象が0件のため終了します。");
    return;
  }

  // 2. 自治体の取得（DBに無ければその場で自動作成！）
  let municipality = await prisma.municipality.findFirst({
    where: {
      prefecture: opts.prefecture,
      name: opts.city,
    },
  });

  if (!municipality) {
    console.log(
      `ℹ️ 自治体「${opts.prefecture} ${opts.city}」が未登録のため自動作成します...`
    );
    municipality = await prisma.municipality.create({
      data: {
        prefecture: opts.prefecture,
        name: opts.city,
        code: opts.code,
        status: "COMPLETED",
        boardCount: boards.length,
      },
    });
  }

  // 3. --clear 指定時は既存の掲示場をリセット
  if (opts.clear) {
    const deleted = await prisma.board.deleteMany({
      where: { municipalityId: municipality.id },
    });
    console.log(`🗑️ 既存のピン ${deleted.count} 件を削除しました。`);
  }

  // 4. PostGIS の geography(POINT, 4326) として直接 boards テーブルへ流し込む
  let insertedCount = 0;
  let updatedCount = 0;

  await prisma.$transaction(async (tx) => {
    for (const b of boards) {
      // 同じ自治体・同じ掲示場番号がすでにあれば UPDATE、無ければ INSERT
      const existing = b.boardNumber
        ? await tx.board.findFirst({
            where: {
              municipalityId: municipality.id,
              boardNumber: b.boardNumber,
              deletedAt: null,
            },
            select: { id: true },
          })
        : null;

      if (existing) {
        await tx.$executeRaw`
          UPDATE "boards"
          SET
            "name" = ${b.name},
            "address" = ${b.address},
            "location" = ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography,
            "trust_level" = 'LEVEL_1'::"TrustLevel",
            "updated_at" = NOW()
          WHERE "id" = ${existing.id}
        `;
        updatedCount++;
      } else {
        const newId = crypto.randomUUID();
        await tx.$executeRaw`
          INSERT INTO "boards" (
            "id",
            "board_number",
            "name",
            "address",
            "location",
            "municipality_id",
            "trust_level",
            "status",
            "created_at",
            "updated_at"
          ) VALUES (
            ${newId},
            ${b.boardNumber},
            ${b.name},
            ${b.address},
            ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography,
            ${municipality.id},
            'LEVEL_1'::"TrustLevel",
            'PENDING'::"BoardStatus",
            NOW(),
            NOW()
          )
        `;
        insertedCount++;
      }
    }

    // 自治体の掲示場数とステータスも完了に更新
    const totalCount = await tx.board.count({
      where: { municipalityId: municipality.id, deletedAt: null },
    });
    await tx.municipality.update({
      where: { id: municipality.id },
      data: {
        boardCount: totalCount,
        status: "COMPLETED",
      },
    });
  });

  console.log(`🎉 DBへの直接取り込みが完了しました！`);
  console.log(`   対象自治体 : ${municipality.prefecture} ${municipality.name} (ID: ${municipality.id})`);
  console.log(`   新規登録   : ${insertedCount} 件`);
  console.log(`   上書き更新 : ${updatedCount} 件`);
  console.log(`👉 マップで確認: http://localhost:4000/municipalities/${municipality.id}`);
}

main()
  .catch((err) => {
    console.error("❌ エラー:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
