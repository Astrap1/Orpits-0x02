import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import StartPage from "./pages/StartPage";
import Editor from "./pages/Editor";

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<StartPage />} />
        <Route path="/editor/:noteId" element={<Editor />} />
      </Routes>
    </Router>
  );
}

export default App;