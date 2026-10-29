import { onRequest as __api_wall___path___js_onRequest } from "D:\\DSH\\创业项目\\photo-map-wall\\functions\\api\\wall\\[[path]].js"

export const routes = [
    {
      routePath: "/api/wall/:path*",
      mountPath: "/api/wall",
      method: "",
      middlewares: [],
      modules: [__api_wall___path___js_onRequest],
    },
  ]