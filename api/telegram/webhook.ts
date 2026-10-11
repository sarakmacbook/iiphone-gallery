import { POST } from "../../serverless/routes/telegram/webhook.js";
import { routeMethods, toVercelHandler } from "../../serverless/vercel-adapter.js";

export const config = { api: { bodyParser: false } };
export default toVercelHandler(routeMethods({ POST }));
