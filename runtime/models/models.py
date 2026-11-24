from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from runtime.db.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, nullable=False, default='USER')
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class InterestFeedback(Base):
    __tablename__ = "interest_feedback"

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(String, index=True)
    message_id = Column(String, unique=True)
    feedback_type = Column(String)
    user_message = Column(Text)
    assistant_message = Column(Text)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(String, nullable=False, default='未处理', server_default='未处理')
    
    user_id = Column(String, index=True)

class UserFeedback(Base):
    __tablename__ = "user_feedback"

    id = Column(Integer, primary_key=True, index=True)
    text = Column(Text, nullable=False)
    image_paths = Column(JSON)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(String, nullable=False, default='未处理', server_default='未处理')

    user_id = Column(String, index=True)
