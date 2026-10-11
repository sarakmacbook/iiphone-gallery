import { GET, POST } from "../../serverless/routes/telegram/setup.js";
import { routeMethods, toVercelHandler } from "../../serverless/vercel-adapter.js";

export const config = { api: { bodyParser: false } };
export default toVercelHandler(routeMethods({ GET, POST }));
