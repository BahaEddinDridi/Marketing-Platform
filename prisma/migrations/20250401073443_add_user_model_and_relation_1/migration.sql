/*
  Warnings:

  - A unique constraint covering the columns `[user_id,email,source_platform]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Lead_email_source_platform_key";

-- CreateIndex
CREATE UNIQUE INDEX "Lead_user_id_email_source_platform_key" ON "Lead"("user_id", "email", "source_platform");
