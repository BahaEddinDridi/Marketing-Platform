/*
  Warnings:

  - You are about to drop the column `source_platform` on the `Lead` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[orgId,email,source]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Lead_orgId_email_source_platform_key";

-- DropIndex
DROP INDEX "Lead_source_platform_idx";

-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "source_platform",
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'email';

-- CreateIndex
CREATE UNIQUE INDEX "Lead_orgId_email_source_key" ON "Lead"("orgId", "email", "source");
