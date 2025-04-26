/*
  Warnings:

  - A unique constraint covering the columns `[id]` on the table `Organization` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Lead" ALTER COLUMN "orgId" SET DEFAULT 'single-org';

-- AlterTable
ALTER TABLE "LeadConfiguration" ALTER COLUMN "orgId" SET DEFAULT 'single-org';

-- AlterTable
ALTER TABLE "MarketingPlatform" ALTER COLUMN "orgId" SET DEFAULT 'single-org';

-- AlterTable
ALTER TABLE "Organization" ALTER COLUMN "id" SET DEFAULT 'single-org';

-- AlterTable
ALTER TABLE "PlatformCredentials" ALTER COLUMN "type" SET DEFAULT 'AUTH';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "password" DROP NOT NULL,
ALTER COLUMN "orgId" SET DEFAULT 'single-org';

-- CreateTable
CREATE TABLE "MicrosoftPreferences" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'single-org',
    "signInMethod" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MicrosoftPreferences_orgId_key" ON "MicrosoftPreferences"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_id_key" ON "Organization"("id");

-- AddForeignKey
ALTER TABLE "MicrosoftPreferences" ADD CONSTRAINT "MicrosoftPreferences_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
