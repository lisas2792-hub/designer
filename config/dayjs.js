// 固定時區
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz  = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(tz);
dayjs.tz.setDefault('Asia/Taipei');

// 不需 export：只要在 server.js 入口 require 一次，整個專案都會套用
