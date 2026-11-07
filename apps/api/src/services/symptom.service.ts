import prisma from '@homglai/db';
import { AppError } from '../utils/app-error';

/**
 * Symptom list shown on the intake form (SRS 2 "อาการที่ลูกค้าแจ้ง"). ADMIN maintains it.
 * Names are unique within their category (MySQL collation: case-insensitive).
 * A symptom already used on a repair order cannot be deleted (rename it instead), and a category
 * cannot be deleted while it still has symptoms — order history keeps its meaning.
 */
export class SymptomService {
  static list() {
    return prisma.symptomCategory.findMany({
      include: { symptoms: { orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
  }

  private static async assertCategoryNameFree(name: string, exceptId?: number) {
    const clash = await prisma.symptomCategory.findFirst({ where: { name, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new AppError(409, `Category "${name}" already exists`);
  }

  private static async assertSymptomNameFree(name: string, categoryId: number, exceptId?: number) {
    const clash = await prisma.symptom.findFirst({
      where: { name, categoryId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (clash) throw new AppError(409, `Symptom "${name}" already exists in this category`);
  }

  private static async categoryOrThrow(id: number) {
    const category = await prisma.symptomCategory.findUnique({ where: { id } });
    if (!category) throw new AppError(404, 'Symptom category not found');
    return category;
  }

  static async createCategory(name: string) {
    await SymptomService.assertCategoryNameFree(name);
    return prisma.symptomCategory.create({ data: { name } });
  }

  static async renameCategory(id: number, name: string) {
    await SymptomService.categoryOrThrow(id);
    await SymptomService.assertCategoryNameFree(name, id);
    return prisma.symptomCategory.update({ where: { id }, data: { name } });
  }

  static async deleteCategory(id: number) {
    await SymptomService.categoryOrThrow(id);
    const symptoms = await prisma.symptom.count({ where: { categoryId: id } });
    if (symptoms > 0) {
      throw new AppError(409, `Category still has ${symptoms} symptom(s); move or delete them first`, { symptoms });
    }
    await prisma.symptomCategory.delete({ where: { id } });
  }

  static async createSymptom(data: { name: string; categoryId: number }) {
    await SymptomService.categoryOrThrow(data.categoryId);
    await SymptomService.assertSymptomNameFree(data.name, data.categoryId);
    return prisma.symptom.create({ data });
  }

  static async updateSymptom(id: number, data: { name?: string; categoryId?: number }) {
    const symptom = await prisma.symptom.findUnique({ where: { id } });
    if (!symptom) throw new AppError(404, 'Symptom not found');
    const categoryId = data.categoryId ?? symptom.categoryId;
    if (data.categoryId !== undefined) await SymptomService.categoryOrThrow(data.categoryId);
    await SymptomService.assertSymptomNameFree(data.name ?? symptom.name, categoryId, id);
    return prisma.symptom.update({ where: { id }, data: { name: data.name ?? symptom.name, categoryId } });
  }

  static async deleteSymptom(id: number) {
    const symptom = await prisma.symptom.findUnique({ where: { id } });
    if (!symptom) throw new AppError(404, 'Symptom not found');
    const used = await prisma.repairOrderSymptom.count({ where: { symptomId: id } });
    if (used > 0) {
      throw new AppError(409, `Symptom is used on ${used} repair order(s); rename it instead of deleting`, { usedOnOrders: used });
    }
    await prisma.symptom.delete({ where: { id } });
  }
}
