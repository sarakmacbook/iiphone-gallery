import { OPTIONS, POST } from "../../serverless/routes/telegram/login.js";
import { routeMethods, toVercelHandler } from "../../serverless/vercel-adapter.js";

export const config = { api: { bodyParser: false } };
export default toVercelHandler(routeMethods({ POST, OPTIONS }));
