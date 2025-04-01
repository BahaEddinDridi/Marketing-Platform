/*
  Warnings:

  - A unique constraint covering the columns `[email,source_platform]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Lead_email_key";

-- CreateIndex
CREATE INDEX "Lead_source_platform_idx" ON "Lead"("source_platform");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_email_source_platform_key" ON "Lead"("email", "source_platform");
