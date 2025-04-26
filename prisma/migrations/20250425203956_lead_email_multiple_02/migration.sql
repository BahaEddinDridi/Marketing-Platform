/*
  Warnings:

  - A unique constraint covering the columns `[emailId]` on the table `LeadEmail` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "LeadEmail_leadId_key";

-- CreateIndex
CREATE UNIQUE INDEX "LeadEmail_emailId_key" ON "LeadEmail"("emailId");
