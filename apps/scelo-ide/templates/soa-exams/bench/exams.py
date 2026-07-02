"""Registry of the SOA multiple-choice exams and their public sample banks.

The genuinely multiple-choice exams (P, FM, FAM, SRM) are *not* released as
past papers; the SOA instead publishes stable public "sample questions +
sample solutions" PDFs. We fetch those on demand (never vendored into the repo
-- the content is SOA copyright) and parse them locally.

`answer_key_patterns` are tried in order against the solutions text; the first
that matches a line wins for that question number.
"""

EXAMS = {
    "fm": {
        "title": "Exam FM — Financial Mathematics",
        "questions_url": "https://www.soa.org/globalassets/assets/Files/Edu/2018/2018-10-exam-fm-sample-questions.pdf",
        "solutions_url": "https://www.soa.org/globalassets/assets/Files/Edu/2018/2018-10-exam-fm-sample-solutions.pdf",
        # "N. Solution: C", tolerant of OCR noise ("45 . Solution: A",
        # "99. S olution: C", "170. Solution D", "431.  Solution.  E").
        "answer_key_patterns": [r"(?m)^\s*(\d+)\s*\.?\s*S\s*olution\W{0,4}([A-E])\b"],
        "status": "implemented",
    },
    "p": {
        "title": "Exam P — Probability",
        "questions_url": "https://www.soa.org/globalassets/assets/files/edu/edu-exam-p-sample-quest.pdf",
        "solutions_url": "https://www.soa.org/globalassets/assets/files/edu/edu-exam-p-sample-sol.pdf",
        # Verified when the P stage is worked; P solutions use "Answer: X" too.
        "answer_key_patterns": [
            r"(?m)^\s*(\d+)\s*\.?\s*S\s*olution\W{0,4}([A-E])\b",
            r"(?m)^\s*(\d+)\s*\.?\s*Answer\W{0,4}([A-E])\b",
        ],
        "status": "planned",
    },
    "fam": {
        "title": "Exam FAM — Fundamentals of Actuarial Mathematics",
        "questions_url": "https://www.soa.org/globalassets/assets/files/edu/2023/exam-fam-sample-questions.pdf",
        "solutions_url": "https://www.soa.org/globalassets/assets/files/edu/2023/exam-fam-sample-solutions.pdf",
        "answer_key_patterns": [r"(?m)^\s*(\d+)\s*\.?\s*S\s*olution\W{0,4}([A-E])\b"],
        "status": "planned",
    },
    "srm": {
        "title": "Exam SRM — Statistics for Risk Modeling",
        "questions_url": "https://www.soa.org/globalassets/assets/files/edu/2023/exam-srm-sample-questions.pdf",
        "solutions_url": "https://www.soa.org/globalassets/assets/files/edu/2023/exam-srm-sample-solutions.pdf",
        "answer_key_patterns": [r"(?m)^\s*(\d+)\s*\.?\s*S\s*olution\W{0,4}([A-E])\b"],
        "status": "planned",
    },
}
