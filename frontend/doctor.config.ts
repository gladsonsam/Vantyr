import type { ReactDoctorConfig } from "react-doctor/api";

export default {
  ignore: {
    files: [
      "dist/**"
    ]
  },
  rules: {
    "react-doctor/no-giant-component": "off",
    "react-doctor/prefer-useReducer": "off"
  }
} satisfies ReactDoctorConfig;

