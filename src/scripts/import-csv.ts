import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { PrismaClient } from "@prisma/client";
import { BoardImportCsvParser } from "@/features/board-import/application/services/BoardImportCsvParser";

const prisma = new PrismaClient();

async function main() {
  const program = new Command();
  program
    .option("-f, --file <path>", "CSVファイルのパス", "tsukuba-boards.csv")
    .option("--code <code>", "自治体新規作成時のコード", "08220")
    .option(
      "--if-empty",
      "対象自治体に既存データがある場合はスキップする",
      false
    )
    .parse(process.argv);

  const opts = program.opts<{
    file: string;
    code: string;
    ifEmpty: boolean;
  }>();

  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`ファイルが見つかりません: ${filePath}`);
  }

  const rows = new BoardImportCsvParser().parse(fs.readFileSync(filePath));
  if (rows.length === 0) {
    console.log("⚠️ 登録対象が0件のため終了します。");
    return;
  }

  const { prefecture, city } = rows[0];
  let municipality = await prisma.municipality.findFirst({
    where: { prefecture, name: city },
  });

  if (!municipality) {
    municipality = await prisma.municipality.create({
      data: {
        prefecture,
        name: city,
        code: opts.code,
        status: "COMPLETED",
        boardCount: rows.length,
      },
    });
  }

  if (opts.ifEmpty) {
    const existingCount = await prisma.board.count({
      where: { municipalityId: municipality.id, deletedAt: null },
    });
    if (existingCount > 0) {
      console.log(
        `ℹ️ ${prefecture} ${city} には既に ${existingCount} 件のデータがあるためインポートをスキップします。`
      );
      return;
    }
  }

  let inserted = 0;
  let updated = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const r of rows) {
        const existing = r.boardNumber
          ? await tx.board.findFirst({
              where: {
                municipalityId: municipality.id,
                boardNumber: r.boardNumber,
                deletedAt: null,
              },
              select: { id: true },
            })
          : null;

        if (existing) {
          await tx.$executeRaw`
            UPDATE "boards"
            SET
              "name" = ${r.name},
              "address" = ${r.address},
              "note" = ${r.note},
              "location" = ST_SetSRID(ST_MakePoint(${r.longitude}, ${r.latitude}), 4326)::geography,
              "trust_level" = 'LEVEL_1'::"TrustLevel",
              "updated_at" = NOW()
            WHERE "id" = ${existing.id}
          `;
          updated++;
        } else {
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
              "note",
              "created_at",
              "updated_at"
            ) VALUES (
              ${crypto.randomUUID()},
              ${r.boardNumber},
              ${r.name},
              ${r.address},
              ST_SetSRID(ST_MakePoint(${r.longitude}, ${r.latitude}), 4326)::geography,
              ${municipality.id},
              'LEVEL_1'::"TrustLevel",
              'PENDING'::"BoardStatus",
              ${r.note},
              NOW(),
              NOW()
            )
          `;
          inserted++;
        }
      }

      const total = await tx.board.count({
        where: { municipalityId: municipality.id, deletedAt: null },
      });
      await tx.municipality.update({
        where: { id: municipality.id },
        data: { boardCount: total, status: "COMPLETED" },
      });
    },
    { timeout: 60000 }
  );

  console.log(
    `✅ ${prefecture} ${city} の取り込み完了: 新規 ${inserted} 件 / 更新 ${updated} 件`
  );
}

main()
  .catch((err) => {
    console.error("❌ CSV取り込みエラー:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
