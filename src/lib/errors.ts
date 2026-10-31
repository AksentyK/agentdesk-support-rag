export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function publicError(error: unknown): { status: number; error: string } {
  if (error instanceof AppError)
    return { status: error.status, error: error.message };
  const status = (error as { status?: number })?.status;
  if (status === 401 || status === 403)
    return {
      status: 502,
      error:
        "RouterAI отклонил доступ. Проверьте ключ и разрешения в настройках среды.",
    };
  if (status === 429)
    return {
      status: 429,
      error: "Лимит RouterAI исчерпан. Повторите запрос позже.",
    };
  return {
    status: 503,
    error:
      "Операция недоступна. Проверьте подключение к БД, миграции и настройки провайдера.",
  };
}
