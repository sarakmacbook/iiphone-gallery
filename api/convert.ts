import { OPTIONS, POST } from "../serverless/routes/convert.js";
import { routeMethods, toVercelHandler } from "../serverless/vercel-adapter.js";

export const config = { api: { bodyParser: false } };
export default toVercelHandler(routeMethods({ POST, OPTIONS }));
